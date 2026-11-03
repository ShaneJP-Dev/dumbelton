"""Fast, dependency-light structure analysis with librosa.

Beats come from librosa's beat tracker. Downbeats assume 4/4; the bar phase
is the one where harmonic change and low-frequency onsets are strongest.

Sections use Laplacian structural segmentation (McFee & Ellis, 2014): a
recurrence graph on beat-synchronous CQT plus a timbre (MFCC) path graph,
spectral clustering, then a majority vote per bar. Clusters become labels with
simple musical heuristics (the loudest repeated part is the chorus, etc.).
"""

from __future__ import annotations

from collections import Counter, defaultdict

import librosa
import numpy as np
import scipy.linalg
import scipy.ndimage
import scipy.sparse.csgraph
from sklearn.cluster import KMeans

from ..types import RawAnalysis, RawSection

SR = 22050
HOP = 512
BEATS_PER_BAR = 4


def _per_interval(feat: np.ndarray, frames: np.ndarray, agg=np.median) -> np.ndarray:
    """Aggregate feature columns over [frames[i], frames[i+1]) intervals."""
    cols = []
    n = feat.shape[1]
    for a, b in zip(frames[:-1], frames[1:]):
        a = int(min(a, n - 1))
        b = int(max(a + 1, min(b, n)))
        cols.append(agg(feat[:, a:b], axis=1))
    return np.stack(cols, axis=1)


def _downbeat_phase(chroma_b: np.ndarray, low_onset_b: np.ndarray) -> int:
    c = chroma_b / (np.linalg.norm(chroma_b, axis=0, keepdims=True) + 1e-9)
    change = np.concatenate([[0.0], 1.0 - np.sum(c[:, 1:] * c[:, :-1], axis=0)])
    def z(x: np.ndarray) -> np.ndarray:
        return (x - x.mean()) / (x.std() + 1e-9)
    score = z(change) + z(low_onset_b)
    return int(np.argmax([score[p::BEATS_PER_BAR].mean() for p in range(BEATS_PER_BAR)]))


def _robust_interval(diffs: np.ndarray) -> float:
    """Mean beat interval ignoring outliers. Beat times are quantised to the STFT hop,
    so the mean of inliers is more accurate than the median."""
    med = float(np.median(diffs))
    inl = diffs[np.abs(diffs - med) <= 0.15 * med]
    return float(np.mean(inl)) if len(inl) else med


def fill_beat_grid(beat_times: list[float], duration: float) -> list[float]:
    """Extend a beat grid over parts the tracker missed (drumless intros, outros, breakdowns).

    Interior gaps of ~2+ beats are filled evenly; the head and tail are extrapolated
    with the local beat interval. Worship/pop stems are usually on a steady click,
    so a continuous grid is a better guess than none.
    """
    bt = np.asarray(sorted(beat_times), dtype=float)
    if len(bt) < 4:
        return bt.tolist()
    med = float(np.median(np.diff(bt)))
    out = [float(bt[0])]
    for a, b in zip(bt[:-1], bt[1:]):
        n = int(round((b - a) / med))
        if n >= 2:
            step = (b - a) / n
            out.extend(float(a + step * k) for k in range(1, n))
        out.append(float(b))
    head = _robust_interval(np.diff(bt[:17]))
    pre = []
    t = out[0] - head
    while t > -0.1 * head:
        pre.append(max(0.0, t))
        t -= head
    out = sorted(pre) + out
    tail = _robust_interval(np.diff(bt[-17:]))
    t = out[-1] + tail
    while t < duration - 0.25 * tail:
        out.append(float(t))
        t += tail
    return out


def _choose_k(evals: np.ndarray, lo: int = 3, hi: int = 7) -> int:
    gaps = np.diff(evals[: hi + 1])
    ks = np.arange(1, len(gaps) + 1)
    mask = (ks >= lo) & (ks <= hi)
    return int(ks[mask][np.argmax(gaps[mask])])


def _cluster_beats(y: np.ndarray, beat_frames: np.ndarray) -> np.ndarray:
    C = librosa.amplitude_to_db(
        np.abs(librosa.cqt(y=y, sr=SR, hop_length=HOP, bins_per_octave=36, n_bins=7 * 36)), ref=np.max
    )
    Csync = _per_interval(C, beat_frames)
    R = librosa.segment.recurrence_matrix(Csync, width=3, mode="affinity", sym=True)
    Rf = librosa.segment.timelag_filter(scipy.ndimage.median_filter)(R, size=(1, 7))

    mfcc = librosa.feature.mfcc(y=y, sr=SR, hop_length=HOP)
    Msync = _per_interval(mfcc, beat_frames)
    path_distance = np.sum(np.diff(Msync, axis=1) ** 2, axis=0)
    sigma = np.median(path_distance) + 1e-9
    path_sim = np.exp(-path_distance / sigma)
    R_path = np.diag(path_sim, k=1) + np.diag(path_sim, k=-1)

    deg_path = np.sum(R_path, axis=1)
    deg_rec = np.sum(Rf, axis=1)
    mu = deg_path.dot(deg_path + deg_rec) / (np.sum((deg_path + deg_rec) ** 2) + 1e-9)
    A = mu * Rf + (1 - mu) * R_path

    L = scipy.sparse.csgraph.laplacian(A, normed=True)
    evals, evecs = scipy.linalg.eigh(L)
    evecs = scipy.ndimage.median_filter(evecs, size=(9, 1))
    k = _choose_k(evals)
    Cnorm = np.cumsum(evecs**2, axis=1) ** 0.5
    X = evecs[:, :k] / (Cnorm[:, k - 1 : k] + 1e-9)
    return KMeans(n_clusters=k, n_init=10, random_state=0).fit_predict(X)


def _bars_from_beats(beat_labels: np.ndarray, phase: int) -> list[tuple[int, int, int]]:
    """Majority-vote beat labels per bar -> runs of (first_beat, end_beat, cluster)."""
    n = len(beat_labels)
    starts = [0] + list(range(phase if phase > 0 else BEATS_PER_BAR, n, BEATS_PER_BAR))
    starts = sorted(set(starts))
    bars = []
    for a, b in zip(starts, starts[1:] + [n]):
        if b > a:
            bars.append((a, b, Counter(beat_labels[a:b].tolist()).most_common(1)[0][0]))
    return bars


def _merge_alternating(runs: list[list[int]], max_bars: float = 4.0) -> list[list[int]]:
    """Merge clusters that only ever appear as short alternating sub-phrases of one section.

    A chorus whose two halves have different chords (C-G | Am-F) clusters as
    X Y X Y. If every run of X touches a run of Y and vice versa, and both are
    short on average, they are one section type.
    """
    changed = True
    while changed:
        changed = False
        clusters = sorted({r[2] for r in runs})
        for x in clusters:
            for y in clusters:
                if x >= y:
                    continue
                ix = [i for i, r in enumerate(runs) if r[2] == x]
                iy = [i for i, r in enumerate(runs) if r[2] == y]
                if len(ix) < 2 or len(iy) < 2:
                    continue
                avg = lambda idx: sum(runs[i][3] for i in idx) / len(idx)
                if avg(ix) > max_bars or avg(iy) > max_bars:
                    continue
                def touches(i: int, other: int) -> bool:
                    return any(0 <= j < len(runs) and runs[j][2] == other for j in (i - 1, i + 1))
                if all(touches(i, y) for i in ix) and all(touches(i, x) for i in iy):
                    for r in runs:
                        if r[2] == y:
                            r[2] = x
                    runs = _join_same(runs)
                    changed = True
                    break
            if changed:
                break
    return runs


def _join_same(runs: list[list[int]]) -> list[list[int]]:
    out: list[list[int]] = []
    for r in runs:
        if out and out[-1][2] == r[2]:
            out[-1][1] = r[1]
            out[-1][3] += r[3]
        else:
            out.append(list(r))
    return out


def _runs(bars: list[tuple[int, int, int]], min_bars: int = 2) -> list[list[int]]:
    """Group bars into runs [start_beat, end_beat, cluster]; absorb runs shorter than min_bars."""
    runs: list[list[int]] = []
    for a, b, c in bars:
        if runs and runs[-1][2] == c:
            runs[-1][1] = b
        else:
            runs.append([a, b, c, 0])
        runs[-1][3] += 1
    changed = True
    while changed and len(runs) > 1:
        changed = False
        for i, r in enumerate(runs):
            if r[3] < min_bars:
                j = i - 1 if i > 0 else 1
                tgt = runs[j]
                tgt[0], tgt[1] = min(tgt[0], r[0]), max(tgt[1], r[1])
                tgt[3] += r[3]
                del runs[i]
                changed = True
                break
        # join neighbours that now share a cluster
        k = 1
        while k < len(runs):
            if runs[k][2] == runs[k - 1][2]:
                runs[k - 1][1] = runs[k][1]
                runs[k - 1][3] += runs[k][3]
                del runs[k]
            else:
                k += 1
    return runs


def _bar_features(feats: list[np.ndarray], bars: list[tuple[int, int, int]]) -> np.ndarray:
    """Mean of beat-level features per bar, each dimension z-scored over the song."""
    F = np.concatenate(feats, axis=0)
    cols = [F[:, a:b].mean(axis=1) for a, b, _c in bars]
    B = np.stack(cols, axis=1)
    mu = B.mean(axis=1, keepdims=True)
    sd = B.std(axis=1, keepdims=True) + 1e-6
    return (B - mu) / sd


def _novelty(B: np.ndarray, width: int = 4) -> np.ndarray:
    """nov[k] = distance between the `width` bars before boundary k and the `width` bars after it."""
    n = B.shape[1]
    nov = np.zeros(n + 1)
    for k in range(1, n):
        left = B[:, max(0, k - width) : k].mean(axis=1)
        right = B[:, k : min(n, k + width)].mean(axis=1)
        nov[k] = float(np.linalg.norm(left - right))
    return nov


def _refine_runs(runs: list[list[int]], bars: list[tuple[int, int, int]], B: np.ndarray, radius: int = 2) -> list[list[int]]:
    """Move each run boundary (by up to `radius` bars) to where the music changes most.

    Spectral clustering is smoothed over a few beats, so a boundary can come out a
    bar early or late. The bar-level novelty peak is a sharper estimate.
    """
    if len(runs) < 2:
        return runs
    starts = [a for a, _b, _c in bars]
    bar_of = {a: i for i, a in enumerate(starts)}
    nov = _novelty(B)
    out = [list(r) for r in runs]
    for i in range(1, len(out)):
        k = bar_of.get(out[i][0])
        if k is None:
            continue
        lo_bar = bar_of.get(out[i - 1][0], 0) + 2
        hi_bar = (bar_of.get(out[i][1], len(starts)) if out[i][1] in bar_of else len(starts)) - 2
        cands = [c for c in range(k - radius, k + radius + 1) if lo_bar <= c <= hi_bar and 0 < c < len(starts)]
        if not cands:
            continue
        best = max(cands, key=lambda c: (nov[c], -abs(c - k)))
        if best != k and nov[best] > 1.15 * nov[k]:
            delta = best - k
            out[i - 1][1] = out[i][0] = starts[best]
            out[i - 1][3] += delta
            out[i][3] -= delta
    return out


def label_segments(clusters: list[int], energies: list[float], durations: list[float]) -> list[str]:
    """Turn a cluster-id sequence into musical labels."""
    n = len(clusters)
    if n == 0:
        return []
    occ = Counter(clusters)
    positions: dict[int, list[int]] = defaultdict(list)
    for i, c in enumerate(clusters):
        positions[c].append(i)
    energy: dict[int, float] = {}
    for c, idx in positions.items():
        w = np.array([durations[i] for i in idx])
        e = np.array([energies[i] for i in idx])
        energy[c] = float(np.sum(w * e) / (np.sum(w) + 1e-9))

    repeated = [c for c in occ if occ[c] >= 2]
    chorus = max(repeated or list(occ), key=lambda c: energy[c])

    def is_edge_only(c: int) -> bool:
        return all(i in (0, n - 1) for i in positions[c])

    verse_cands = [c for c in repeated if c != chorus and not is_edge_only(c)]
    verse = min(verse_cands, key=lambda c: (positions[c][0], -occ[c])) if verse_cands else None

    labels = []
    for i, c in enumerate(clusters):
        if c == chorus:
            labels.append("chorus")
        elif c == verse:
            labels.append("verse")
        elif i == 0:
            labels.append("intro")
        elif i == n - 1:
            labels.append("outro")
        elif occ[c] >= 2 and all(p + 1 < n and clusters[p + 1] == chorus for p in positions[c]):
            labels.append("pre-chorus")
        elif occ[c] == 1 and i >= n / 2:
            labels.append("bridge")
        else:
            labels.append("inst")
    return labels


def analyze(path: str) -> RawAnalysis:
    y, _ = librosa.load(path, sr=SR, mono=True)
    duration = len(y) / SR
    y_harm, y_perc = librosa.effects.hpss(y)
    _tempo, tracked = librosa.beat.beat_track(y=y_perc, sr=SR, hop_length=HOP, trim=False)
    tracked_times = librosa.frames_to_time(np.unique(tracked.astype(int)), sr=SR, hop_length=HOP)
    beat_times = fill_beat_grid(tracked_times.tolist(), duration)
    beat_frames = np.unique(librosa.time_to_frames(beat_times, sr=SR, hop_length=HOP))
    beat_times = librosa.frames_to_time(beat_frames, sr=SR, hop_length=HOP).tolist()
    bpm = 60.0 / _robust_interval(np.diff(beat_times)) if len(beat_times) > 1 else 0.0

    if len(beat_frames) < 4 * BEATS_PER_BAR:
        return RawAnalysis(duration, bpm, beat_times, beat_times[::BEATS_PER_BAR],
                           [RawSection(0.0, duration, "inst")], "librosa")

    n_frames = 1 + len(y) // HOP
    frames = np.concatenate([beat_frames, [n_frames]])  # interval i = [beat i, beat i+1)

    chroma = librosa.feature.chroma_cqt(y=y_harm, sr=SR, hop_length=HOP)
    chroma_b = _per_interval(chroma, frames)
    low_onset = librosa.onset.onset_strength(y=y_perc, sr=SR, hop_length=HOP, fmax=200, n_mels=32)
    low_onset_b = low_onset[np.minimum(beat_frames, len(low_onset) - 1)]
    phase = _downbeat_phase(chroma_b, low_onset_b)
    downbeat_times = beat_times[phase::BEATS_PER_BAR]

    beat_labels = _cluster_beats(y, frames)
    bars = _bars_from_beats(beat_labels, phase)
    runs = _merge_alternating(_runs(bars))

    mfcc_b = _per_interval(librosa.feature.mfcc(y=y, sr=SR, hop_length=HOP, n_mfcc=20), frames, agg=np.mean)
    rms_b = _per_interval(librosa.feature.rms(y=y, hop_length=HOP), frames, agg=np.mean)
    # timbre + loudness only: chords also change inside sections, instrumentation mostly does not
    B = _bar_features([mfcc_b, np.repeat(np.log(rms_b + 1e-4), 4, axis=0)], bars)
    runs = _refine_runs(runs, bars, B)

    rms = librosa.feature.rms(y=y, hop_length=HOP)[0]
    bt = beat_times + [duration]
    energies, durations = [], []
    for a, b, _c, _nb in runs:
        fa, fb = int(frames[a]), int(frames[min(b, len(frames) - 1)])
        energies.append(float(np.mean(rms[fa:max(fb, fa + 1)])))
        durations.append(bt[b] - bt[a] if b < len(bt) else duration - bt[a])
    labels = label_segments([r[2] for r in runs], energies, durations)

    sections = []
    for (a, b, _c, _nb), lab in zip(runs, labels):
        start = 0.0 if a == 0 else bt[a]
        end = duration if b >= len(beat_times) else bt[b]
        sections.append(RawSection(start, end, lab))
    return RawAnalysis(duration, bpm, beat_times, downbeat_times, sections, "librosa",
                       extra={"phase": phase, "clusters": [int(r[2]) for r in runs]})
