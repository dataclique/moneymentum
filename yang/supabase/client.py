"""
Supabase client utilities for connection and credentials management.
"""

import logging
import os

from dotenv import load_dotenv
from supabase import Client, create_client

load_dotenv()
logger = logging.getLogger(__name__)
logger.info("Loaded environment variables from .env file")


def get_supabase_client() -> Client | None:
    """
    Create and return Supabase client using environment variables.

    Returns:
        Supabase client instance or None if connection fails
    """
    SUPABASE_URL: str | None = os.getenv("SUPABASE_URL")
    SUPABASE_KEY: str | None = os.getenv("SUPABASE_KEY")

    if not SUPABASE_URL or not SUPABASE_KEY:
        logger.error("Supabase credentials not found in environment variables.")
        logger.error("Create a .env file with: SUPABASE_URL=your_url and SUPABASE_KEY=your_key")
        return None

    try:
        supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    except Exception:
        logger.exception("Error connecting to Supabase")
        return None
    else:
        logger.info("Successfully connected to Supabase")
        return supabase
