export interface LoadBendaOptions {
  /** Port of the Benda bridge, as in benda.config.json. Default: 4399. */
  port?: number;
  /** Project name, as in benda.config.json. The overlay only loads from the bridge of this project. */
  name?: string;
}

/** Loads the Benda overlay from the local bridge. Does nothing outside dev mode. */
export declare function loadBenda(options?: LoadBendaOptions): void;
