/** A config file is invalid. The message names the file and the setting. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}
