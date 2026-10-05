/** Preview congestion discards stale frames; screenshots fail explicitly before admission. */
export function devicePacketDelivery(ports: {
  bufferedBytes(): number;
  authorize(): boolean;
  write(packet: Buffer): Promise<void>;
}) {
  const admit = () => {
    if (!ports.authorize()) throw new Error("Device stream access revoked");
    return ports.bufferedBytes() <= 128 * 1024;
  };
  return {
    async frame(packet: Buffer): Promise<void> {
      if (admit()) await ports.write(packet);
    },
    async image(packet: Buffer): Promise<void> {
      if (!admit())
        throw new Error("Screenshot delivery congested; retry when the connection recovers");
      await ports.write(packet);
    },
  };
}
