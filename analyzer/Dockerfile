# Analyzer image.
#   docker build -t analyzer .                    -> librosa backend (default, fast, small)
#   docker build -t analyzer:allin1 --target allin1 .  -> All-In-One model backend (large, slower, better labels)
FROM python:3.11-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsndfile1 ffmpeg \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:0.5.11 /uv /bin/uv
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --python /usr/local/bin/python3.11
COPY app ./app
ENV PATH=/app/.venv/bin:$PATH \
    ANALYZER_BACKEND=librosa \
    PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

# All-In-One (allin1) backend. Untested in CI: the build needs download.pytorch.org,
# shi-labs.com (natten wheels), github.com (madmom) and huggingface.co (model weights).
# natten must match the torch version exactly; allin1 1.1.0 uses natten's 0.17-era API.
FROM base AS allin1
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential git \
 && rm -rf /var/lib/apt/lists/*
RUN uv pip install --python /app/.venv torch==2.3.1 torchaudio==2.3.1 \
      --index-url https://download.pytorch.org/whl/cpu
RUN uv pip install --python /app/.venv "natten==0.17.1+torch230cpu" -f https://shi-labs.com/natten/wheels/
# madmom's PyPI release does not build on Python 3.10+; install from git.
RUN uv pip install --python /app/.venv cython "numpy<2" \
 && uv pip install --python /app/.venv --no-build-isolation "madmom @ git+https://github.com/CPJKU/madmom"
RUN uv pip install --python /app/.venv allin1==1.1.0
# Download the model weights at build time so the first song is not slow.
RUN python -c "from allin1.models import load_pretrained_model as l; l('harmonix-all', device='cpu')"
ENV ANALYZER_BACKEND=allin1
