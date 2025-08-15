import random
from typing import Dict, List, Optional
from dataclasses import asdict
from datetime import datetime
from app.models.items import ItemDef, LootBoxDef, LootBoxDrop, ItemType, Rarity
from app.models.enums import MessageType
from app.services.auth_service import auth_service
from app.db.database import get_session
from app.db.repositories.item_repository import item_repository, loot_box_repository
import asyncio


class LootBoxService:
    """Loot box and item service backed by database.

    Bootstraps defaults if tables empty (idempotent). Former JSON file persistence removed.
    """
    def __init__(self):
        self.items: Dict[str, ItemDef] = {}
        self.boxes: Dict[str, LootBoxDef] = {}
        # Async bootstrap
        async def _bootstrap():
            try:
                async for session in get_session():
                    # Load existing
                    db_items = await item_repository.list_items(session)
                    for raw in db_items:
                        self.items[raw['id']] = ItemDef(
                            id=raw['id'], type=ItemType(raw['type']), name=raw['name'], rarity=Rarity(raw['rarity']),
                            payload=raw['payload'], tags=raw['tags']
                        )
                    db_boxes = await loot_box_repository.list_boxes(session)
                    for raw in db_boxes:
                        self.boxes[raw['id']] = LootBoxDef(
                            id=raw['id'], name=raw['name'], price_coins=raw['price_coins'],
                            drops=[LootBoxDrop(**d) for d in raw.get('drops', [])],
                            guaranteed=raw.get('guaranteed', []), rarity_bonus=raw.get('rarity_bonus', {}),
                            max_rolls=raw.get('max_rolls', 1)
                        )
                    if not self.items:
                        self._seed_defaults()
                        # Persist defaults
                        for item in self.items.values():
                            await item_repository.upsert_item(session, {
                                'id': item.id,
                                'type': item.type.value,
                                'name': item.name,
                                'rarity': item.rarity.value,
                                'payload': item.payload,
                                'tags': item.tags
                            })
                        for box in self.boxes.values():
                            await loot_box_repository.upsert_box(session, {
                                'id': box.id,
                                'name': box.name,
                                'price_coins': box.price_coins,
                                'drops': [asdict(d) for d in box.drops],
                                'guaranteed': box.guaranteed,
                                'rarity_bonus': box.rarity_bonus,
                                'max_rolls': box.max_rolls
                            })
                        await session.commit()
            except Exception as e:
                print(f"⚠️ Loot bootstrap failed: {e}")
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                loop.create_task(_bootstrap())
            else:
                loop.run_until_complete(_bootstrap())
        except RuntimeError:
            asyncio.run(_bootstrap())

    # (Removed file persistence methods)

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
        # Precompute adjusted weights using tier weights + box rarity_bonus
        try:
            from app.services.tier_service import get_tiers
            import asyncio as _asyncio
            # Synchronously fetch cached tiers (get_tiers will hit cache unless empty)
            if _asyncio.get_event_loop().is_running():
                tiers = _asyncio.get_event_loop().run_until_complete(get_tiers())  # fallback if running
            else:
                tiers = _asyncio.run(get_tiers())
            tier_weight_map = {t['key']: t['weight'] for t in tiers}
        except Exception:
            tier_weight_map = {}
        rarity_bonus = box.rarity_bonus or {}
        adjusted = []
        for d in pool:
            it = self.items.get(d.item_id)
            base_w = d.weight
            if it:
                rar = getattr(it, 'rarity', None)
                key = rar.value if isinstance(rar, Rarity) else rar
                tier_w = tier_weight_map.get(key, 1)
                bonus = rarity_bonus.get(key, 0)
                base_w = max(1, int(base_w * tier_w + bonus))
            adjusted.append((d, base_w))
        for _ in range(rolls):
            total_weight = sum(w for _, w in adjusted)
            r = random.uniform(0, total_weight)
            upto = 0
            chosen: Optional[LootBoxDrop] = None
            for d, w in adjusted:
                if upto + w >= r:
                    chosen = d
                    break
                upto += w
            if not chosen:
                chosen = adjusted[-1][0]
            granted = self._grant_item(user, chosen.item_id)
            if granted:
                awarded_items.append(granted)
        # Persist
        auth_service._save_user(username)
        # Identify rare unlocks (epic+)
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
                for item in rare_unlocks:
                    user_regions = region_manager.user_regions.get(username, set()) or []
                    if not user_regions:
                        continue
                    payload = {"type": MessageType.NEW_ITEM_UNLOCKED.value, "user_id": username, "item": item}
                    import asyncio
                    for (rx, ry) in user_regions:
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
