from datetime import datetime


def normalize_timestamp(timestamp: str | datetime) -> datetime:
    if isinstance(timestamp, datetime):
        # If it's already a datetime object, normalize it and return
        return timestamp.replace(microsecond=0)
    if isinstance(timestamp, str):
        # If it's a string, parse it and return as a datetime object
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).replace(microsecond=0)
    error_message = f"Unsupported timestamp type: {type(timestamp)}"
    raise TypeError(error_message)
