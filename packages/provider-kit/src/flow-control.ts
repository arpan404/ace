/** A transport reads only while its owner has room to accept another fact. */
export interface OutputFlow {
  paused(): boolean;
  wait(): Promise<void>;
}
