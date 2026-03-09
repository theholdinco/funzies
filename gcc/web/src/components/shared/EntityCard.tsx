import { motion } from 'motion/react';
import type { EntityType } from '../../types';

const BADGE_CONFIG: Record<EntityType, { label: string; className: string; accent: string }> = {
  tribe: { label: 'Tribe', className: 'badge-tribe', accent: 'border-accent/20 hover:shadow-accent/10' },
  family: { label: 'Family', className: 'badge-family', accent: 'border-slate/20 hover:shadow-slate/10' },
  figure: { label: 'Figure', className: 'badge-figure', accent: 'border-plum/20 hover:shadow-plum/10' },
  ethnic: { label: 'Ethnic Group', className: 'badge-ethnic', accent: 'border-sage/20 hover:shadow-sage/10' },
  event: { label: 'Event', className: 'badge-event', accent: 'border-ochre/20 hover:shadow-ochre/10' },
  region: { label: 'Region', className: 'badge-region', accent: 'border-slate/20 hover:shadow-slate/10' },
};

interface EntityCardProps {
  type: EntityType;
  name: string;
  description?: string | null;
  onClick?: () => void;
}

export default function EntityCard({ type, name, description, onClick }: EntityCardProps) {
  const config = BADGE_CONFIG[type];

  return (
    <motion.button
      onClick={onClick}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.98 }}
      className={`w-full text-left bg-bg-raised border ${config.accent} rounded-xl p-4
                  hover:shadow-md transition-shadow cursor-pointer group`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold text-text group-hover:text-accent transition-colors truncate">
            {name}
          </h3>
        </div>
        <span className={`${config.className} text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 mt-1`}>
          {config.label}
        </span>
      </div>

      {description && (
        <p className="text-xs text-text-secondary leading-relaxed line-clamp-2">
          {description}
        </p>
      )}
    </motion.button>
  );
}
