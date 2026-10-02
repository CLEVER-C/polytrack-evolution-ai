/**
 * Thrown by placeholder methods that define a contract but have no implementation yet.
 */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`Not implemented yet: ${what}`);
    this.name = "NotImplementedError";
  }
}
