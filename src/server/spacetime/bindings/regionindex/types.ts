// Row types for the `regionindex` shard — plain interfaces, SDK-decoupled.
// u64 → bigint, u16 → number.

export interface RegionShard {
  macroRegion: bigint;
  dataShard: number;
}
