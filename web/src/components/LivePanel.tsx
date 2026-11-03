import type { Project } from '../lib/types';

export function LivePanel({ project }: { project: Project }) {
  return <div className="py-2 text-sm text-gray-400">Live {project.name}</div>;
}
