from hyperliquid.info import Info
from hyperliquid.utils import constants

info = Info(constants.MAINNET_API_URL, skip_ws=True)
user_state = info.user_state("0x84D14a8480737c223168B083Bcda189aC7783010")
print(user_state)
