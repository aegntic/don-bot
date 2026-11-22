export const TRUST_PACKAGE_VERSION = '0.1.0-alpha.0';

export interface SandboxPort {
  readonly kind: 'bwrap' | 'worktree';
}
