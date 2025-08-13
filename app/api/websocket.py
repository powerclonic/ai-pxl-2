"""
WebSocket endpoints for real-time communication.
"""
import json
from fastapi import WebSocket, WebSocketDisconnect
from app.models import MessageType
from app.services import RegionManager

async def websocket_endpoint(websocket: WebSocket, user_id: str, region_manager: RegionManager):
    """Handle WebSocket connections for real-time communication"""
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
