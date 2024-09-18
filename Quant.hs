{-# LANGUAGE OverloadedStrings #-}
{-# LANGUAGE StrictData #-}
{-# LANGUAGE TypeApplications #-}
{-# LANGUAGE NoImplicitPrelude #-}

module Main (main) where

import Conduit
import Data.Csv
import Data.Csv.Conduit
import Data.Scientific (Scientific)
import Data.Time.Clock (UTCTime)
import Data.Time.Format.ISO8601 (iso8601ParseM)
import Protolude


data Candle = Candle
  { timestamp :: UTCTime
  , ticker :: Text
  , resolution :: Text
  , low :: Scientific
  , high :: Scientific
  , open :: Scientific
  , close :: Scientific
  , baseTokenVolume :: Scientific
  , volumeUSD :: Scientific
  , trades :: Integer
  , startingOpenInterest :: Scientific
  , orderbookMidPriceOpen :: Scientific
  , orderbookMidPriceClose :: Scientific
  }
  deriving (Show)


instance FromNamedRecord Candle where
  parseNamedRecord r =
    Candle
      <$> (r .: "timestamp" >>= iso8601ParseM)
      <*> r .: "ticker"
      <*> r .: "resolution"
      <*> r .: "low"
      <*> r .: "high"
      <*> r .: "open"
      <*> r .: "close"
      <*> r .: "baseTokenVolume"
      <*> r .: "volumeUSD"
      <*> r .: "trades"
      <*> r .: "startingOpenInterest"
      <*> r .: "orderbookMidPriceOpen"
      <*> r .: "orderbookMidPriceClose"


pipeline
  :: ( MonadResource m
     , MonadError CsvParseError m
     )
  => ConduitT i o m ()
pipeline =
  sourceFileBS "./data/hourly.csv"
    .| fromNamedCsv @Candle defaultDecodeOptions
    .| mapC show
    .| sinkHandle stdout


main :: IO ()
main = run pipeline
  where
    run = runResourceT . (either print pure <=< runExceptT . runConduit)
