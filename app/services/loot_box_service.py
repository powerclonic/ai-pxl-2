import json, os, random, time
from typing import Dict, List, Optional
from dataclasses import asdict
from app.models.items import ItemDef, LootBoxDef, LootBoxDrop, ItemType, Rarity
from app.models.enums import MessageType
from app.services.auth_service import auth_service
from datetime import datetime

DATA_DIR = "data"
ITEMS_FILE = os.path.join(DATA_DIR, "items.json")
BOXES_FILE = os.path.join(DATA_DIR, "loot_boxes.json")

class LootBoxService:
    def __init__(self):
        self.items: Dict[str, ItemDef] = {}
        self.boxes: Dict[str, LootBoxDef] = {}
        os.makedirs(DATA_DIR, exist_ok=True)
        self._load_all()
        if not self.items:
            self._seed_defaults()
            self._save_all()

    # ================== Persistence ==================
    def _load_all(self):
        try:
            if os.path.exists(ITEMS_FILE):
                with open(ITEMS_FILE, 'r') as f:
                    data = json.load(f)
                    for raw in data:
                        self.items[raw['id']] = ItemDef(**raw)
            if os.path.exists(BOXES_FILE):
                with open(BOXES_FILE, 'r') as f:
                    data = json.load(f)
                    for raw in data:
                        raw['drops'] = [LootBoxDrop(**d) for d in raw.get('drops', [])]
                        self.boxes[raw['id']] = LootBoxDef(**raw)
        except Exception as e:
            print(f"⚠️ Failed loading loot data: {e}")

    def _save_all(self):
        try:
            with open(ITEMS_FILE, 'w') as f:
                json.dump([asdict(i) for i in self.items.values()], f, indent=2)
            with open(BOXES_FILE, 'w') as f:
                boxes_serial = []
                for b in self.boxes.values():
                    bd = asdict(b)
                    bd['drops'] = [asdict(d) for d in b.drops]
                    boxes_serial.append(bd)
                json.dump(boxes_serial, f, indent=2)
        except Exception as e:
            print(f"⚠️ Failed saving loot data: {e}")

    # ================== Defaults ==================
    def _seed_defaults(self):
        base_items = [
            ItemDef(id="col_basic_red", type=ItemType.COLOR, name="Red", rarity=Rarity.COMMON, payload={"color":"#ff2d2d"}),
            ItemDef(id="col_basic_blue", type=ItemType.COLOR, name="Blue", rarity=Rarity.COMMON, payload={"color":"#2d6dff"}),
            ItemDef(id="col_glow_purple", type=ItemType.COLOR, name="Glow Purple", rarity=Rarity.RARE, payload={"color":"#b24dff","effect":"glow"}, tags=["effect:glow"]) ,
            ItemDef(id="col_spark_gold", type=ItemType.COLOR, name="Spark Gold", rarity=Rarity.EPIC, payload={"color":"#ffcc33","effect":"spark"}, tags=["effect:spark"]),
            ItemDef(id="up_bag_5", type=ItemType.UPGRADE, name="Bag +5", rarity=Rarity.RARE, payload={"max_pixel_bag_delta":5}),
            ItemDef(id="up_bag_10", type=ItemType.UPGRADE, name="Bag +10", rarity=Rarity.EPIC, payload={"max_pixel_bag_delta":10}),
        ]
        for it in base_items:
            self.items[it.id] = it
        starter_box = LootBoxDef(
            id="starter_box", name="Starter Box", price_coins=50,
            drops=[LootBoxDrop(item_id=i.id, weight=10) for i in base_items],
            guaranteed=["col_basic_red"], max_rolls=1
        )
        premium_box = LootBoxDef(
            id="premium_box", name="Premium Box", price_coins=200,
            drops=[LootBoxDrop(item_id=i.id, weight=(5 if i.rarity==Rarity.LEGENDARY else 15 if i.rarity==Rarity.EPIC else 25 if i.rarity==Rarity.RARE else 40)) for i in base_items],
            guaranteed=["col_basic_blue"], max_rolls=2
        )
        self.boxes[starter_box.id] = starter_box
        self.boxes[premium_box.id] = premium_box

    # ================== Public API ==================
    def list_items(self):
        return [asdict(i) for i in self.items.values()]
    def list_boxes(self):
        out = []
        for b in self.boxes.values():
            bd = asdict(b)
            bd['drops'] = [asdict(d) for d in b.drops]
            out.append(bd)
        return out

    def get_item(self, item_id: str) -> Optional[ItemDef]:
        return self.items.get(item_id)

    def open_box(self, username: str, box_id: str) -> dict:
        user = auth_service.get_user_by_username(username)
        if not user:
            return {"success": False, "error": "User not found"}
        box = self.boxes.get(box_id)
        if not box:
            return {"success": False, "error": "Box not found"}
        if user.coins < box.price_coins:
            return {"success": False, "error": "Insufficient coins"}
        # Rate limit simple: 1 per 1s
        now = datetime.now()
        if user.last_lootbox_open_at and (now - user.last_lootbox_open_at).total_seconds() < 1:
            return {"success": False, "error": "Too fast"}

        user.coins -= box.price_coins
        user.last_lootbox_open_at = now
        user.lootbox_opens += 1

        awarded_items: List[dict] = []
        guaranteed = []
        for gid in box.guaranteed:
            granted = self._grant_item(user, gid)
            if granted:
                guaranteed.append(granted)
        rolls = box.max_rolls
        pool = box.drops
        for _ in range(rolls):
            total_weight = sum(d.weight for d in pool)
            r = random.uniform(0, total_weight)
            upto = 0
            chosen: Optional[LootBoxDrop] = None
            for d in pool:
                if upto + d.weight >= r:
                    chosen = d
                    break
                upto += d.weight
            if not chosen:
                chosen = pool[-1]
            granted = self._grant_item(user, chosen.item_id)
            if granted:
                awarded_items.append(granted)
        # Persist
        auth_service._save_user(username)
        # Identify raros para broadcast (epic+)
        rare_unlocks = [i for i in awarded_items + guaranteed if i['rarity'] in (Rarity.EPIC, Rarity.LEGENDARY)]
        result = {
            "success": True,
            "box_id": box_id,
            "spent": box.price_coins,
            "awarded": awarded_items,
            "guaranteed": guaranteed,
            "coins": user.coins
        }
        # Broadcast rare unlocks (non-blocking best-effort) via region_manager user regions
        if rare_unlocks:
            try:
                from app.main import region_manager
                # Compose message per rare
                for item in rare_unlocks:
                    # Broadcast to all regions user currently in
                    user_regions = region_manager.user_regions.get(username, set()) or []
                    payload = {
                        "type": MessageType.NEW_ITEM_UNLOCKED.value,
                        "user_id": username,
                        "item": item
                    }
                    # If no regions tracked yet, skip
                    if not user_regions:
                        continue
                    for (rx, ry) in user_regions:
                        # Exclude user to let their own UI handle via REST response? We'll still include them.
                        # Simplicity: send to everyone.
                        import asyncio
                        asyncio.create_task(region_manager.broadcast_to_region(rx, ry, payload))
            except Exception as e:
                print(f"⚠️ Rare unlock broadcast failed: {e}")
        return result

    def _grant_item(self, user, item_id: str):
        item = self.items.get(item_id)
        if not item:
            return None
        duplicate = False
        compensation = 0
        # Apply effects / ownership
        if item.type == ItemType.COLOR:
            if item.id not in user.owned_colors:
                user.owned_colors.append(item.id)
            else:
                duplicate = True
        elif item.type == ItemType.EFFECT:
            if item.id not in user.owned_effects:
                user.owned_effects.append(item.id)
            else:
                duplicate = True
        elif item.type == ItemType.UPGRADE:
            delta = item.payload.get("max_pixel_bag_delta", 0)
            if delta:
                user.max_pixel_bag_size += int(delta)
        elif item.type == ItemType.CURRENCY_PACK:
            amount = int(item.payload.get("coins", 0))
            user.coins += amount
        # Duplicate compensation -> convert to coins based on rarity
        if duplicate:
            rarity = item.rarity
            comp_map = {
                Rarity.COMMON: 10,
                Rarity.RARE: 35,
                Rarity.EPIC: 120,
                Rarity.LEGENDARY: 400
            }
            compensation = comp_map.get(rarity, 5)
            user.coins += compensation
        # Record generic inventory always (still track counts)
        user.inventory[item.id] = user.inventory.get(item.id, 0) + 1
        return {
            "item_id": item.id,
            "type": item.type,
            "name": item.name,
            "rarity": item.rarity,
            "payload": item.payload,
            "duplicate": duplicate,
            "compensation_coins": compensation
        }

loot_box_service = LootBoxService()
