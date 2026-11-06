'use client';

import { categories } from '@hive/shared';
import { Icon } from './ui/icons';

export function CategoryPicker({ value, onChange, multiple = false, counts, label = 'Categories' }: {
  value: string[]; onChange: (value: string[]) => void; multiple?: boolean; counts?: Record<string, number>; label?: string;
}) {
  return <div role="group" aria-label={label} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
    {categories.map(category => {
      const selected = value.includes(category.slug);
      return <button key={category.slug} type="button" aria-pressed={selected} onClick={() => onChange(selected ? value.filter(item => item !== category.slug) : multiple ? [...value, category.slug] : [category.slug])}
        className={`flex min-h-12 min-w-0 items-center gap-2 rounded-xl border px-3 py-3 text-left text-sm font-medium transition ${selected ? 'border-brand bg-brand-soft text-brand' : 'border-white/10 bg-surface hover:bg-brand-soft'}`}>
        <Icon name={category.icon} size={18} /><span className="truncate">{category.label}</span>{counts && <span className="ml-auto text-xs">{counts[category.slug] ?? 0}</span>}
      </button>;
    })}
  </div>;
}

export function InterestPicker({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  return <CategoryPicker label="Your interests" value={value} onChange={onChange} multiple />;
}
