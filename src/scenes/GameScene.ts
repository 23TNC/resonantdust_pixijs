import { GameView } from "@/ui/components/GameView";
import {
  type ServerPlayer,
  setSoulId, setObserverId,
  type CardId,
  ZONE_SIZE,
  zoneQFromMacro, zoneRFromMacro,
  localQFromMicro, localRFromMicro,
} from "@/spacetime/Data";
import { spacetime } from "@/spacetime/SpacetimeManager";

export class GameScene extends GameView {
  constructor(player: ServerPlayer) {
    super();
    setSoulId(player.soul_id as CardId);
    setObserverId(player.soul_id as CardId);
    spacetime.setViewedSoul(this, player.soul_id as CardId);

    const world_q = zoneQFromMacro(player.macro_location) * ZONE_SIZE + localQFromMicro(player.micro_location);
    const world_r = zoneRFromMacro(player.macro_location) * ZONE_SIZE + localRFromMicro(player.micro_location);

    this.tick();
    this.getWorld().centerOnHex(world_q, world_r);
  }
}
