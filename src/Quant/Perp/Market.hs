module Quant.Perp.Market where

import Data.Aeson
import Protolude hiding (yield)


data PerpMarket = PerpMarket
  { fullName :: Text
  , -- , category :: [Text]
    symbol :: Text
  , baseAssetSymbol :: Text
  , marketIndex :: Integer
  , launchTs :: Integer
  -- , oracle :: Text
  -- , oracleSource :: Text
  -- , pythFeedId :: Maybe Text
  }
  deriving stock (Show, Generic, Eq)
  deriving anyclass (FromJSON)
