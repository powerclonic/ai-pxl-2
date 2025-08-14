"""
FastAPI application factory and main application setup.
"""
from fastapi import FastAPI, Request, WebSocket
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from app.core.config import settings
from app.services import RegionManager
from app.api import create_api_router, websocket_endpoint
from app.api.auth import router as auth_router

def create_app() -> FastAPI:
    """Create and configure FastAPI application"""
    app = FastAPI(
        title="Pixel Canvas",
        description="A collaborative pixel canvas application with authentication",
        version="2.0.0"
    )
    
    # Mount static files and templates
    app.mount(f"/{settings.STATIC_DIR}", StaticFiles(directory=settings.STATIC_DIR), name="static")
    templates = Jinja2Templates(directory=settings.TEMPLATES_DIR)
    
    # Create global region manager
    region_manager = RegionManager()
    
    # Add authentication routes
    app.include_router(auth_router)
    
    # Add API routes
    api_router = create_api_router(region_manager)
    app.include_router(api_router)
    
    # Main page route
    @app.get("/")
    async def get_index(request: Request):
        return templates.TemplateResponse("index.html", {"request": request})
    
    # WebSocket route
    @app.websocket("/ws/{user_id}")
    async def websocket_route(websocket: WebSocket, user_id: str):
        await websocket_endpoint(websocket, user_id, region_manager)
    
    return app

# Create app instance
app = create_app()
