from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List

class ItemType(str, Enum):
    COLOR = "color"
    EFFECT = "effect"
    UPGRADE = "upgrade"
    CURRENCY_PACK = "currency_pack"

class Rarity(str, Enum):
    COMMON = "common"
    RARE = "rare"
    EPIC = "epic"
    LEGENDARY = "legendary"

RARITY_WEIGHTS_DEFAULT = {
    Rarity.COMMON: 60,
    Rarity.RARE: 25,
    Rarity.EPIC: 12,
    Rarity.LEGENDARY: 3,
}

@dataclass
class ItemDef:
    id: str
    type: ItemType
    name: str
    rarity: Rarity
    payload: Dict[str, Any] = field(default_factory=dict)  # e.g. {"color":"#ffaa11", "effect":"sparkle"}
    tags: List[str] = field(default_factory=list)
    # Example for upgrades: payload might contain {"max_pixel_bag_delta":5}

@dataclass
class LootBoxDrop:
    item_id: str
    weight: int  # relative weight inside box

@dataclass
class LootBoxDef:
    id: str
    name: str
    price_coins: int
    drops: List[LootBoxDrop]
    guaranteed: List[str] = field(default_factory=list)  # always grant (e.g. base color)
    rarity_bonus: Dict[str, int] = field(default_factory=dict)  # optional per-rarity weight adjustments
    max_rolls: int = 1  # number of distinct items granted per open (besides guaranteed)
