"""
Configuration settings for the Pixel Canvas application.
"""
import os

class Settings:
    """Application settings"""
    
    # Canvas settings
    CANVAS_SIZE: int = 8192
    REGION_SIZE: int = 512
    REGIONS_PER_SIDE: int = CANVAS_SIZE // REGION_SIZE  # 16x16 grid
    
    # Pixel bag system
    PIXEL_REFILL_RATE: float = 3.0  # Seconds to refill one pixel
    MAX_PIXEL_BAG: int = 10  # Maximum pixels in bag
    INITIAL_PIXEL_BAG: int = 3  # Starting pixels
    
    # Authentication & Security
    SECRET_KEY: str = "your-secret-key-change-in-production"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 30
    ALGORITHM: str = "HS256"
    
    # Rate limiting & Anti-bot
    MAX_ACTIONS_PER_MINUTE: int = 60  # Max actions per user per minute
    CAPTCHA_REQUIRED_AFTER_FAILURES: int = 3  # Show CAPTCHA after failed attempts
    CAPTCHA_EXPIRE_MINUTES: int = 5
    MIN_USERNAME_LENGTH: int = 3
    MAX_USERNAME_LENGTH: int = 20
    MIN_PASSWORD_LENGTH: int = 6
    
    # Admin settings
    DEFAULT_ADMIN_USERNAME: str = "admin"
    DEFAULT_ADMIN_PASSWORD: str = "admin123"  # Change in production!
    
    # Ban settings
    TEMP_BAN_DURATION_HOURS: int = 24
    MAX_FAILED_CAPTCHA_ATTEMPTS: int = 5
    
    # Chat settings
    MAX_CHAT_HISTORY_PER_REGION: int = 50
    CHAT_HISTORY_RESPONSE_LIMIT: int = 20
    
    # Server settings
    HOST: str = "0.0.0.0"
    PORT: int = 8000
    DEBUG: bool = True
    
    # Static files
    STATIC_DIR: str = "static"
    TEMPLATES_DIR: str = "templates"

    # --- Persistence / Infra (env overridable) ---
    DATABASE_URL: str = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./data/app.db")
    REDIS_URL: str = os.getenv("REDIS_URL", "redis://localhost:6379/0")
    ENABLE_REDIS: bool = os.getenv("ENABLE_REDIS", "true").lower() == "true"
    DB_POOL_SIZE: int = int(os.getenv("DB_POOL_SIZE", "10"))
    DB_POOL_MAX_OVERFLOW: int = int(os.getenv("DB_POOL_MAX_OVERFLOW", "20"))
    METRICS_FLUSH_INTERVAL_MS: int = int(os.getenv("METRICS_FLUSH_INTERVAL_MS", "3000"))
    CANVAS_SNAPSHOT_INTERVAL_SEC: int = int(os.getenv("CANVAS_SNAPSHOT_INTERVAL_SEC", "300"))
    CANVAS_SNAPSHOT_RETENTION: int = int(os.getenv("CANVAS_SNAPSHOT_RETENTION", "50"))

# Global settings instance
settings = Settings()
