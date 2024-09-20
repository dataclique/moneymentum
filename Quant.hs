{-# LANGUAGE DeriveAnyClass #-}
{-# LANGUAGE StrictData #-}

module Main (main) where

import Conduit
import Data.Csv
import Data.Csv.Conduit
import Data.Scientific (Scientific)
import Data.Text qualified as Text
-- import Data.Time.Format.ISO8601 (iso8601ParseM)

import Data.Time (UTCTime (UTCTime), defaultTimeLocale, formatTime)
import Data.Time.Calendar.Month
import Data.Time.Calendar.OrdinalDate
import Network.HTTP.Client.Conduit (parseRequest)
import Network.HTTP.Simple (getResponseBody, httpSource)
import Protolude


main :: IO ()
main = run pipeline
  where
    run = runResourceT . (either print pure <=< runExceptT . runConduit)


pipeline
  :: ( PrimMonad m
     , MonadThrow m
     , MonadResource m
     , MonadError CsvParseError m
     )
  => ConduitT i o m ()
pipeline = do
  req <- parseRequest $ traceShowId url
  httpSource req getResponseBody
    -- .| ungzip
    .| fromNamedCsv @PerpTrade defaultDecodeOptions
    .| mapC show
    .| sinkHandle stdout
  where
    year = 2024
    date = YearDay year 1
    marketSymbol = "SOL-PERP"

    baseUrl =
      "https://drift-historical-data-v2.s3.eu-west-1.amazonaws.com"
    program = "program/dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
    market = "market/" <> marketSymbol
    file = formatTime defaultTimeLocale "%Y%m%d" date
    -- show year <> month <> day

    url =
      intercalate "/" [baseUrl, program, market, "tradeRecords", show year, file]


-- url =
--   "https://drift-historical-data-v2.s3.eu-west-1.amazonaws.com/program/dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH/user/FrEFAwxdrzHxgc7S4cuFfsfLmcg8pfbxnkCQW83euyCS/tradeRecords/2023/20230201"

data PerpTrade = PerpTrade
  { -- Identifies the type of data being streamed. trades_perp_0 indicates data for trades in perp market 0. (SOL-PERP)
    ts :: Integer -- UTCTime
  , -- Index of the market where the trade occurred.
    marketIndex :: Integer
  , -- Type of the market, here it's perp for perpetual.
    marketType :: Text
  , -- The address or identifier of the filler (taker) in the trade.
    filler :: Text
  , -- Fee paid by the taker in the trade.
    takerFee :: Scientific
  , -- Fee paid or received by the maker in the trade.
    makerFee :: Scientific
  , -- Surplus amount in quote asset.
    quoteAssetAmountSurplus :: Scientific
  , -- The amount of the base asset that was filled in this trade.
    baseAssetAmountFilled :: Scientific
  , -- The amount of the quote asset that was filled in this trade.
    quoteAssetAmountFilled :: Scientific
  , -- Order ID of the taker's order, if available.
    takerOrderId :: Maybe Text
  , -- Base asset amount specified in the taker's order.
    takerOrderBaseAssetAmount :: Scientific
  , -- Cumulative base asset amount filled in the taker's order.
    takerOrderCumulativeBaseAssetAmountFilled :: Scientific
  , -- Cumulative quote asset amount filled in the taker's order.
    takerOrderCumulativeQuoteAssetAmountFilled :: Scientific
  , -- The address or identifier of the maker in the trade.
    maker :: Text
  , -- Order ID of the maker's order.
    makerOrderId :: Text
  , -- Direction of the maker's order (e.g., 'short' or 'long').
    makerOrderDirection :: Text
  , -- Base asset amount specified in the maker's order.
    makerOrderBaseAssetAmount :: Scientific
  , -- Cumulative base asset amount filled in the maker's order.
    makerOrderCumulativeBaseAssetAmountFilled :: Scientific
  , -- Cumulative quote asset amount filled in the maker's order.
    makerOrderCumulativeQuoteAssetAmountFilled :: Scientific
  , -- The oracle price at the time of the trade.
    oraclePrice :: Scientific
  , -- Transaction signature.
    txSig :: Text
  , -- Slot number in which the trade occurred.
    slot :: Integer
  , -- fill.
    action :: Text
  , -- Explanation of the action (e.g., 'orderFilledWithAmm' indicating order filled with Automated Market Maker).
    actionExplanation :: Text
  , -- Reward amount for the referrer, if applicable.
    referrerReward :: Scientific
  }
  deriving stock (Show, Generic)
  deriving anyclass (FromNamedRecord, ToNamedRecord)
