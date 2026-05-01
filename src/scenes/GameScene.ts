import { GameView } from "@/ui/components/GameView";
import {
  type ServerPlayer,
  setSoulId, setObserverId,
  type CardId,
  ZONE_SIZE,
  zoneQFromMacro, zoneRFromMacro,
  localQFromMicroZone, localRFromMicroZone,
} from "@/spacetime/Data";
import { spacetime } from "@/spacetime/SpacetimeManager";

export class GameScene extends GameView {
  constructor(player: ServerPlayer) {
    super();
    setSoulId(player.soul_id as CardId);
    setObserverId(player.soul_id as CardId);
    spacetime.setViewedSoul(this, player.soul_id as CardId);

    const world_q = zoneQFromMacro(player.macro_zone) * ZONE_SIZE + localQFromMicroZone(player.micro_zone);
    const world_r = zoneRFromMacro(player.macro_zone) * ZONE_SIZE + localRFromMicroZone(player.micro_zone);

    this.tick();
    this.getWorld().centerOnHex(world_q, world_r);
  }
}
