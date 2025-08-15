from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Type, TypeVar

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

# ---- Helper parsing utilities (case-insensitive, accept enum names or values) ----
E = TypeVar('E', bound=Enum)

def parse_enum(enum_cls: Type[E], raw: str) -> E:
    """Parse an enum value in a case-insensitive way.

    Accepts either the member name (e.g. "UPGRADE") or the value (e.g. "upgrade").
    Raises ValueError listing valid options if not found.
    """
    if raw is None:
        raise ValueError(f"Missing value for {enum_cls.__name__}")
    candidate = str(raw).strip()
    lower = candidate.lower()
    for member in enum_cls:  # match by value
        if member.value.lower() == lower or member.name.lower() == lower:
            return member  # type: ignore
    valid = ", ".join(sorted({m.name for m in enum_cls}))
    raise ValueError(f"Invalid {enum_cls.__name__} '{raw}'. Valid: {valid}")

def parse_item_type(raw: str) -> ItemType:
    return parse_enum(ItemType, raw)

def parse_rarity(raw: str):
    """Parse rarity.

    Accepts built-in Enum values OR any custom tier key saved via tier_service.
    Returns the Enum member when it matches, otherwise the normalized lowercase string.
    """
    try:
        return parse_enum(Rarity, raw)
    except ValueError:
        # Allow custom tiers: normalize
        val = (raw or '').strip().lower()
        if not val:
            raise
        return val
