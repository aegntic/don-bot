export const META_PACKAGE_VERSION = '0.6.0-rc.2';

export function getMetaStatus(): { readonly meta: string } {
  return { meta: META_PACKAGE_VERSION };
}

export * from './mailbox.ts';
export * from './registry.ts';
export * from './roles.ts';
export * from './templates.ts';
export * from './workflows.ts';
