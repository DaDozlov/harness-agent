import pkg from '../package.json' with { type: 'json' };

/** The installed version of heaw. */
export const VERSION: string = pkg.version;
