import { Avatar as SharedAvatar, type AvatarProps } from '@hive/ui';
import { API_URL } from '../../lib/api';

export { colourFor } from '@hive/ui';

/** Resolve relative API media URLs for the shared avatar. */
export function Avatar({ src, square: _square, ...props }: AvatarProps & { square?: boolean }) {
  return <SharedAvatar {...props} src={src?.startsWith('/') ? `${API_URL}${src}` : src} />;
}
