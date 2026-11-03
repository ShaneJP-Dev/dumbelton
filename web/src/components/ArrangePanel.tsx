import type { Project } from '../lib/types';

export function ArrangePanel({ project }: { project: Project }) {
  return <div className="py-2 text-sm text-gray-400">Arrange {project.name}</div>;
}
