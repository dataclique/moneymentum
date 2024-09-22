{-# LANGUAGE DeriveAnyClass #-}
{-# LANGUAGE StrictData #-}

module Main (main) where

import Conduit
import Data.Aeson
import Data.ByteString.Lazy qualified as BSL
import Data.Csv
import Data.Csv.Conduit
import Data.Scientific (Scientific)
import Data.Time (
  UTCTime (UTCTime),
  defaultTimeLocale,
  formatTime,
  getCurrentTime,
 )
import Data.Time.Calendar.OrdinalDate
import Network.HTTP.Client.Conduit (parseRequest)
import Network.HTTP.Simple (getResponseBody, httpSource)
import Protolude hiding (yield)
import System.Directory (createDirectoryIfMissing)


main :: IO ()
main = run pipeline
  where
    run = runResourceT . (either print pure <=< runExceptT . runConduit)


startDay :: Day
startDay = YearDay 2024 9


pipeline
  :: ( MonadThrow m
     , MonadResource m
     , MonadError CsvParseError m
     )
  => ConduitT i o m ()
pipeline = do
  let path = "./data/drift-perp-markets.json"
  markets <- liftIO $ Data.Aeson.decode @[PerpMarket] <$> BSL.readFile path

  case markets of
    Nothing ->
      liftIO $ putStrLn @Text "Failed to parse markets:\n"
    Just markets -> do
      UTCTime endDay _ <- liftIO getCurrentTime
      let range = [startDay .. endDay]
      forM_ markets $ \market -> do
        yieldMany range .| await >>= \case
          Nothing -> pure ()
          Just day -> do
            liftIO $
              putStrLn $
                "Processing "
                  <> symbol market
                  <> " day "
                  <> show (length [startDay .. day])
                  <> " of "
                  <> show (length range)
            tradesOnDay market day


data PerpMarket = PerpMarket
  { fullName :: Text
  , -- , category :: [Text]
    symbol :: Text
  , baseAssetSymbol :: Text
  , marketIndex :: Integer
  -- , launchTs :: Integer
  -- , oracle :: Text
  -- , oracleSource :: Text
  -- , pythFeedId :: Maybe Text
  }
  deriving stock (Show, Generic)
  deriving anyclass (FromJSON)


tradesOnDay
  :: ( MonadThrow m
     , MonadResource m
     , MonadError CsvParseError m
     )
  => PerpMarket
  -> Day
  -> ConduitT i o m ()
tradesOnDay (PerpMarket {..}) date = do
  liftIO $ createDirectoryIfMissing True outDir

  req <- parseRequest url
  httpSource req getResponseBody
    .| fromNamedCsv @PerpTrade defaultDecodeOptions
    .| toCsv defaultEncodeOptions
    .| sinkFile path
  where
    YearDay year _ = date
    path = outDir <> "/" <> outFile
    outDir = "./data/perp-trades/" <> toS baseAssetSymbol
    outFile = formatTime defaultTimeLocale "%Y-%m-%d" date <> ".csv"

    baseUrl = "https://drift-historical-data-v2.s3.eu-west-1.amazonaws.com"
    program = "program/dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
    market = "market/" <> toS symbol
    file = formatTime defaultTimeLocale "%Y%m%d" date
    url = intercalate "/" [baseUrl, program, market, "tradeRecords", show year, file]


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
  deriving anyclass (FromNamedRecord, ToRecord)
