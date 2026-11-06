import { categories } from '@hive/shared';
import type { Space } from '../../lib/spaces';
import { Icon } from '../ui/icons';

export function CategoryChips({ space }: { space: Pick<Space, 'type' | 'category' | 'tags'> }) {
  if (space.type !== 'community') return null;
  const category = categories.find(item => item.slug === space.category) ?? categories.at(-1)!;
  return <div className="my-3 flex flex-wrap gap-2 text-xs">
    <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-1 font-medium text-brand"><Icon name={category.icon} size={13} />{category.label}</span>
    {space.tags.map(tag => <span key={tag} className="rounded-full bg-white/5 px-2.5 py-1 text-white/70">#{tag}</span>)}
  </div>;
}
