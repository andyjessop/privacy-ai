"""
title: Custom Settings Injector
author: Andy Jessop
author_url: https://github.com/andyjessop
funding_url: https://github.com/andyjessop
version: 0.1.0
"""

from typing import Optional, Dict, Any, Awaitable, Callable
from pydantic import BaseModel, Field

class Filter:
    class Valves(BaseModel):
        # Admin-only settings (if any)
        pass

    class UserValves(BaseModel):
        # These appear in the user's "Controls" settings for the chat
        save_memories: bool = Field(
            default=True, description="Save this conversation to memory?"
        )
        anonymous_mode: bool = Field(
            default=False, description="Anonymize my identity for this chat?"
        )

    def __init__(self):
        self.valves = self.Valves()
        # Note: self.user_valves is not initialized here; it's passed in inlet/outlet

    async def inlet(
        self, 
        body: dict, 
        __user__: Optional[dict] = None, 
        __user_valves__: Optional[UserValves] = None
    ) -> dict:
        """
        Injects user settings into the request body before sending to the API.
        """
        print(f"inlet: {__name__}")
        print(f"User Valves: {__user_valves__}")

        if __user_valves__:
            # Inject valves into the 'metadata' field (compatible with our API schema)
            # or directly into the body since our Zod schema uses .passthrough()
            
            # Option A: Inject into metadata (Cleaner)
            if "metadata" not in body:
                body["metadata"] = {}
            
            body["metadata"]["save_memories"] = __user_valves__.save_memories
            body["metadata"]["anonymous_mode"] = __user_valves__.anonymous_mode

            # Option B: Inject at top level (if you prefer)
            # body["save_memories"] = __user_valves__.save_memories
            # body["anonymous_mode"] = __user_valves__.anonymous_mode

        return body
