/** Base error for a config file we refuse to trust or cannot use. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** The config file, or its directory, would expose the key to other users. */
export class InsecureConfigError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = "InsecureConfigError";
  }
}
