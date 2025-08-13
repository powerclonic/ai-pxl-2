from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi import Request
import json
import asyncio
import time
import os
from typing import Dict, List, Set, Tuple, Optional
from dataclasses import dataclass, asdict
from enum import Enum

app = FastAPI()

# Mount static files and templates
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Constants
CANVAS_SIZE = 8192
REGION_SIZE = 512
REGIONS_PER_SIDE = CANVAS_SIZE // REGION_SIZE  # 16x16 grid of regions
PIXEL_REFILL_RATE = 3  # Seconds to refill one pixel
MAX_PIXEL_BAG = 10  # Maximum pixels in bag
DATA_FILE = "canvas_data.json"  # File to store pixel data

class MessageType(Enum):
    PIXEL_PLACE = "pixel_place"
    PIXEL_UPDATE = "pixel_update"
    CHAT_MESSAGE = "chat_message"
    CHAT_BROADCAST = "chat_broadcast"
    USER_JOIN = "user_join"
    USER_LEAVE = "user_leave"
    REGION_DATA = "region_data"
    USER_POSITION = "user_position"
    PING = "ping"
    PONG = "pong"

@dataclass
class Pixel:
    x: int
    y: int
    color: str
    timestamp: float
    user_id: str

@dataclass
class ChatMessage:
    user_id: str
    message: str
    timestamp: float
    region_x: int
    region_y: int

@dataclass
class User:
    websocket: WebSocket
    current_region_x: int = 0
    current_region_y: int = 0
    last_chat_time: float = 0  # Track last chat message time
    pixel_bag: int = 3
    last_bag_refill: float = 0

class PixelCanvas:
    def __init__(self):
        # Canvas data organized by regions for optimization
        self.regions: Dict[Tuple[int, int], Dict[Tuple[int, int], Pixel]] = {}
        self.initialize_regions()
        self.load_data()
        self.unsaved_changes = False
        self.last_save_time = time.time()
    
    def initialize_regions(self):
        """Initialize empty regions"""
        for region_x in range(REGIONS_PER_SIDE):
            for region_y in range(REGIONS_PER_SIDE):
                self.regions[(region_x, region_y)] = {}
    
    def load_data(self):
        """Load pixel data from file"""
        if os.path.exists(DATA_FILE):
            try:
                with open(DATA_FILE, 'r') as f:
                    data = json.load(f)
                    
                print(f"Loading {len(data.get('pixels', []))} pixels from {DATA_FILE}")
                
                for pixel_data in data.get('pixels', []):
                    x = pixel_data['x']
                    y = pixel_data['y']
                    color = pixel_data['color']
                    timestamp = pixel_data['timestamp']
                    user_id = pixel_data['user_id']
                    
                    region_coords = self.get_region_coords(x, y)
                    local_coords = self.get_local_coords(x, y)
                    
                    pixel = Pixel(x, y, color, timestamp, user_id)
                    self.regions[region_coords][local_coords] = pixel
                
                print("Canvas data loaded successfully")
            except Exception as e:
                print(f"Error loading canvas data: {e}")
        else:
            print("No existing canvas data found, starting with empty canvas")
    
    def save_data(self):
        """Save pixel data to file"""
        try:
            pixels_data = []
            
            # Collect all pixels from all regions
            for region_coords, region_pixels in self.regions.items():
                for local_coords, pixel in region_pixels.items():
                    pixels_data.append({
                        'x': pixel.x,
                        'y': pixel.y,
                        'color': pixel.color,
                        'timestamp': pixel.timestamp,
                        'user_id': pixel.user_id
                    })
            
            data = {
                'pixels': pixels_data,
                'last_save': time.time(),
                'total_pixels': len(pixels_data)
            }
            
            # Save to temporary file first, then rename for atomic write
            temp_file = DATA_FILE + '.tmp'
            with open(temp_file, 'w') as f:
                json.dump(data, f, indent=2)
            
            os.rename(temp_file, DATA_FILE)
            print(f"Saved {len(pixels_data)} pixels to {DATA_FILE}")
            self.unsaved_changes = False
            self.last_save_time = time.time()
            
        except Exception as e:
            print(f"Error saving canvas data: {e}")
    
    def should_save(self) -> bool:
        """Check if we should save based on changes and time"""
        current_time = time.time()
        # Save if there are unsaved changes and it's been more than 30 seconds
        return self.unsaved_changes and (current_time - self.last_save_time > 30)
    
    def get_region_coords(self, x: int, y: int) -> Tuple[int, int]:
        """Get region coordinates from pixel coordinates"""
        return (x // REGION_SIZE, y // REGION_SIZE)
    
    def get_local_coords(self, x: int, y: int) -> Tuple[int, int]:
        """Get local coordinates within a region"""
        return (x % REGION_SIZE, y % REGION_SIZE)
    
    def place_pixel(self, x: int, y: int, color: str, user_id: str) -> bool:
        """Place a pixel on the canvas"""
        if not (0 <= x < CANVAS_SIZE and 0 <= y < CANVAS_SIZE):
            return False
        
        region_coords = self.get_region_coords(x, y)
        local_coords = self.get_local_coords(x, y)
        
        pixel = Pixel(x, y, color, time.time(), user_id)
        self.regions[region_coords][local_coords] = pixel
        
        # Mark that we have unsaved changes
        self.unsaved_changes = True
        
        # Auto-save if enough time has passed
        if self.should_save():
            self.save_data()
        
        return True
    
    def get_region_data(self, region_x: int, region_y: int) -> Dict:
        """Get all pixels in a specific region"""
        if (region_x, region_y) not in self.regions:
            return {}
        
        region_data = {}
        for (local_x, local_y), pixel in self.regions[(region_x, region_y)].items():
            region_data[f"{local_x},{local_y}"] = {
                "color": pixel.color,
                "timestamp": pixel.timestamp,
                "user_id": pixel.user_id
            }
        return region_data

class RegionManager:
    def __init__(self):
        self.canvas = PixelCanvas()
        self.users: Dict[str, User] = {}
        self.region_connections: Dict[Tuple[int, int], Set[str]] = {}
        self.chat_history: Dict[Tuple[int, int], List[ChatMessage]] = {}
        self.periodic_save_task = None
        
        # Initialize region connections and chat history
        for region_x in range(REGIONS_PER_SIDE):
            for region_y in range(REGIONS_PER_SIDE):
                self.region_connections[(region_x, region_y)] = set()
                self.chat_history[(region_x, region_y)] = []
    
    def start_periodic_save(self):
        """Start background task to save data periodically"""
        if self.periodic_save_task is None:
            async def periodic_save():
                while True:
                    await asyncio.sleep(60)  # Check every minute
                    if self.canvas.unsaved_changes:
                        print("Performing periodic save...")
                        self.canvas.save_data()
                    else:
                        print("No changes to save.")
            
            # Start the background task
            self.periodic_save_task = asyncio.create_task(periodic_save())
    
    async def connect_user(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        center_region = (REGIONS_PER_SIDE // 2, REGIONS_PER_SIDE // 2)
        
        user = User(
            websocket=websocket,
            current_region_x=center_region[0],
            current_region_y=center_region[1],
            pixel_bag=3,
            last_bag_refill=time.time()
        )
        
        self.users[user_id] = user
        self.region_connections[center_region].add(user_id)
        
        # Send initial region data
        await self.send_region_data(user_id, center_region[0], center_region[1])
        
        # Notify others in the region
        await self.broadcast_to_region(center_region[0], center_region[1], {
            "type": MessageType.USER_JOIN.value,
            "user_id": user_id,
            "region_x": center_region[0],
            "region_y": center_region[1]
        }, exclude_user=user_id)
    
    async def disconnect_user(self, user_id: str):
        if user_id not in self.users:
            return
        
        user = self.users[user_id]
        region_coords = (user.current_region_x, user.current_region_y)
        
        # Remove from region
        self.region_connections[region_coords].discard(user_id)
        
        # Notify others in the region
        await self.broadcast_to_region(region_coords[0], region_coords[1], {
            "type": MessageType.USER_LEAVE.value,
            "user_id": user_id
        }, exclude_user=user_id)
        
        del self.users[user_id]
    
    def refill_pixel_bag(self, user: User):
        current_time = time.time()
        time_passed = current_time - user.last_bag_refill
        pixels_to_add = int(time_passed // PIXEL_REFILL_RATE)
        
        if pixels_to_add > 0:
            user.pixel_bag = min(MAX_PIXEL_BAG, user.pixel_bag + pixels_to_add)
            user.last_bag_refill = current_time
    
    async def place_pixel(self, user_id: str, x: int, y: int, color: str) -> bool:
        if user_id not in self.users:
            return False
        
        user = self.users[user_id]
        
        # Refill pixel bag based on time passed
        self.refill_pixel_bag(user)
        
        # Check if user has pixels in bag
        if user.pixel_bag <= 0:
            await self.send_to_user(user_id, {
                "type": "error",
                "message": "No pixels available! Wait for bag to refill."
            })
            return False
        
        # Place pixel
        if not self.canvas.place_pixel(x, y, color, user_id):
            return False
        
        # Consume a pixel from bag
        user.pixel_bag -= 1
        
        # Broadcast pixel update to all users in the region
        region_coords = self.canvas.get_region_coords(x, y)
        await self.broadcast_to_region(region_coords[0], region_coords[1], {
            "type": MessageType.PIXEL_UPDATE.value,
            "x": x,
            "y": y,
            "color": color,
            "user_id": user_id,
            "timestamp": time.time()
        })
        
        return True
    
    async def move_user_to_region(self, user_id: str, new_region_x: int, new_region_y: int):
        if user_id not in self.users:
            return
        
        user = self.users[user_id]
        old_region = (user.current_region_x, user.current_region_y)
        new_region = (new_region_x, new_region_y)
        
        if old_region == new_region:
            return
        
        # Remove from old region
        self.region_connections[old_region].discard(user_id)
        await self.broadcast_to_region(old_region[0], old_region[1], {
            "type": MessageType.USER_LEAVE.value,
            "user_id": user_id
        }, exclude_user=user_id)
        
        # Add to new region
        self.region_connections[new_region].add(user_id)
        user.current_region_x = new_region_x
        user.current_region_y = new_region_y
        
        # Send new region data
        await self.send_region_data(user_id, new_region_x, new_region_y)
        
        # Notify others in new region
        await self.broadcast_to_region(new_region_x, new_region_y, {
            "type": MessageType.USER_JOIN.value,
            "user_id": user_id,
            "region_x": new_region_x,
            "region_y": new_region_y
        }, exclude_user=user_id)
    
    async def send_chat_message(self, user_id: str, message: str):
        if user_id not in self.users:
            return
        
        user = self.users[user_id]
        
        # Rate limiting: 3 seconds between messages
        current_time = time.time()
        if current_time - user.last_chat_time < 3.0:
            # Send rate limit message to user
            await self.send_to_user(user_id, {
                "type": "rate_limit",
                "message": "Please wait before sending another message."
            })
            return
        
        user.last_chat_time = current_time
        region_coords = (user.current_region_x, user.current_region_y)
        
        chat_msg = ChatMessage(
            user_id=user_id,
            message=message,
            timestamp=time.time(),
            region_x=region_coords[0],
            region_y=region_coords[1]
        )
        
        # Store in chat history (keep last 50 messages per region)
        region_chat = self.chat_history[region_coords]
        region_chat.append(chat_msg)
        if len(region_chat) > 50:
            region_chat.pop(0)
        
        # Broadcast to region
        await self.broadcast_to_region(region_coords[0], region_coords[1], {
            "type": MessageType.CHAT_BROADCAST.value,
            "user_id": user_id,
            "message": message,
            "timestamp": chat_msg.timestamp
        })
    
    async def send_region_data(self, user_id: str, region_x: int, region_y: int):
        region_data = self.canvas.get_region_data(region_x, region_y)
        chat_history = [
            asdict(msg) for msg in 
            self.chat_history[(region_x, region_y)][-20:]
        ]
        
        await self.send_to_user(user_id, {
            "type": MessageType.REGION_DATA.value,
            "region_x": region_x,
            "region_y": region_y,
            "pixels": region_data,
            "chat_history": chat_history,
            "users_in_region": list(self.region_connections[(region_x, region_y)])
        })
    
    async def broadcast_to_region(self, region_x: int, region_y: int, message: dict, exclude_user: str = None):
        region_coords = (region_x, region_y)
        if region_coords not in self.region_connections:
            return
        
        for user_id in self.region_connections[region_coords].copy():
            if user_id != exclude_user:
                await self.send_to_user(user_id, message)
    
    async def send_to_user(self, user_id: str, message: dict):
        if user_id not in self.users:
            return
        
        try:
            await self.users[user_id].websocket.send_text(json.dumps(message))
        except Exception:
            # Connection is broken, remove user
            await self.disconnect_user(user_id)

# Global region manager
region_manager = RegionManager()

@app.on_event("startup")
async def startup_event():
    """Initialize background tasks when server starts"""
    print("Starting periodic save task...")
    region_manager.start_periodic_save()

@app.get("/", response_class=HTMLResponse)
async def get_index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/api/canvas/{region_x}/{region_y}")
async def get_region_data(region_x: int, region_y: int):
    if not (0 <= region_x < REGIONS_PER_SIDE and 0 <= region_y < REGIONS_PER_SIDE):
        return {"error": "Invalid region coordinates"}
    
    region_data = region_manager.canvas.get_region_data(region_x, region_y)
    return {
        "region_x": region_x,
        "region_y": region_y,
        "pixels": region_data
    }

@app.post("/api/save")
async def manual_save():
    """Manual save endpoint for admin use"""
    try:
        region_manager.canvas.save_data()
        return {"success": True, "message": "Canvas data saved successfully"}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.get("/api/stats")
async def get_stats():
    """Get canvas statistics"""
    total_pixels = 0
    for region_pixels in region_manager.canvas.regions.values():
        total_pixels += len(region_pixels)
    
    return {
        "total_pixels": total_pixels,
        "active_users": len(region_manager.users),
        "data_file_exists": os.path.exists(DATA_FILE)
    }

@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    await region_manager.connect_user(websocket, user_id)
    
    try:
        while True:
            # Receive message from client
            data = await websocket.receive_text()
            message = json.loads(data)
            
            message_type = message.get("type")
            print(f"DEBUG: Received message type: {message_type}, message: {message}")
            
            if message_type == MessageType.PIXEL_PLACE.value:
                print(f"DEBUG: Placing pixel at ({message['x']}, {message['y']}) with color {message['color']}")
                result = await region_manager.place_pixel(
                    user_id, 
                    message["x"], 
                    message["y"], 
                    message["color"]
                )
                print(f"DEBUG: Pixel placement result: {result}")
                print(f"DEBUG: Broadcasting pixel update to users")
            
            elif message_type == MessageType.CHAT_MESSAGE.value:
                await region_manager.send_chat_message(
                    user_id, 
                    message["message"]
                )
            
            elif message_type == MessageType.USER_POSITION.value:
                # User moved to a different region
                await region_manager.move_user_to_region(
                    user_id,
                    message["region_x"],
                    message["region_y"]
                )
            
            elif message_type == "ping":
                # Handle ping request
                await websocket.send_text(json.dumps({
                    "type": "pong",
                    "timestamp": message["timestamp"]
                }))
            
    except WebSocketDisconnect:
        await region_manager.disconnect_user(user_id)

if __name__ == "__main__":
    import uvicorn
    import signal
    import sys
    
    def signal_handler(sig, frame):
        print("\nReceived shutdown signal, saving data...")
        region_manager.canvas.save_data()
        print("Data saved. Shutting down gracefully.")
        sys.exit(0)
    
    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)
    
    print("Starting Pixel Canvas Server...")
    print("- Canvas will auto-save every minute")
    print("- Data is saved on every pixel placement")
    print("- Manual save available at /api/save")
    print("- Statistics available at /api/stats")
    
    uvicorn.run(app, host="0.0.0.0", port=8000)
