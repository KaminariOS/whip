import { TextClassContext } from '@/src/components/ui/text';
import { cn } from '@/src/lib/utils';
import type { LucideIcon, LucideProps } from 'lucide-react-native';
import { cssInterop } from 'nativewind';
import * as React from 'react';

type IconProps = LucideProps & { as: LucideIcon } & React.RefAttributes<LucideIcon>;

function IconImpl({ as: IconComponent, ...props }: IconProps) {
  return <IconComponent {...props} />;
}

cssInterop(IconImpl, {
  className: {
    target: 'style',
    nativeStyleToProp: { height: 'size', width: 'size' },
  },
});

function Icon({ as: IconComponent, className, size = 14, ...props }: IconProps) {
  const textClass = React.useContext(TextClassContext);
  return <IconImpl as={IconComponent} className={cn('text-foreground', textClass, className)} size={size} {...props} />;
}

export { Icon };
