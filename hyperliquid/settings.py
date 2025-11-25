import os
from dataclasses import dataclass, field

from dotenv import load_dotenv  # type: ignore[import]

load_dotenv()

def load_required_env(env_var: str) -> str:
    """Load required value from environment variable or raise error"""
    value = os.getenv(env_var)
    if not value:
        msg = f"Required environment variable {env_var} is not set"
        raise ValueError(msg)
    return value

@dataclass(frozen=True)
class UserSettings:
    """
    Any idiosyncratic settings, passwords, account-specific limits, etc.
    """

    public_key: str = field(default_factory=lambda: load_required_env("WALLET_PUBLIC_KEY"))
    secret_key: str = field(default_factory=lambda: load_required_env("WALLET_SECRET_KEY"))