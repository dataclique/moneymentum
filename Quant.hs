{-# LANGUAGE DeriveAnyClass #-}
{-# LANGUAGE StrictData #-}

module Main (main) where

import Conduit ((.|))
import Conduit qualified as C
import Control.Concurrent.Async (forConcurrently_)
import Data.Aeson
import Data.ByteString.Lazy qualified as BSL
import Data.Csv
import Data.Csv.Conduit
import Data.Scientific (Scientific)
import Data.Time (
  UTCTime (UTCTime, utctDay),
  addUTCTime,
  defaultTimeLocale,
  formatTime,
  getCurrentTime,
  secondsToNominalDiffTime,
 )
import Data.Time.Calendar (fromGregorian)
import Data.Time.Calendar.OrdinalDate
import Network.HTTP.Simple (
  Request,
  getResponseBody,
  getResponseStatusCode,
  httpBS,
  parseRequest,
 )
import Protolude hiding (yield)
import System.Directory qualified as Dir
import System.Random (randomRIO)
import Prelude qualified


main :: IO ()
main = do
  let path = "./drift-perp-markets.json"
  markets <-
    Data.Aeson.decode @[PerpMarket]
      <$> BSL.readFile path >>= \case
        Nothing -> panic "Failed to parse markets"
        Just markets -> pure markets

  tasks <- C.runResourceT $ getTasks markets

  forConcurrently_ markets \market ->
    run $
      C.yieldMany (filter ((== market) . fst) tasks)
        .| C.iterMC (uncurry tradesOnDay)
        .| C.sinkNull
  where
    run = C.runResourceT . (either print pure <=< runExceptT . C.runConduit)


startDay :: Day
startDay = fromGregorian 2024 1 1


getTasks
  :: ( C.MonadThrow m
     , C.MonadResource m
     )
  => [PerpMarket]
  -> m [(PerpMarket, Day)]
getTasks markets = do
  UTCTime endDay _ <- liftIO getCurrentTime
  let range = Prelude.init [startDay .. endDay]
  let unix = UTCTime (fromGregorian 1970 1 1) 0

  let perpDir = "data/perp-trades/"
  perpDirExists <- liftIO $ Dir.doesDirectoryExist perpDir

  forM_ markets \PerpMarket {..} -> do
    let outDir = "./data/perp-trades/" <> toS baseAssetSymbol
    liftIO $ Dir.createDirectoryIfMissing True outDir

  if not perpDirExists
    then do
      liftIO $ Dir.createDirectoryIfMissing True perpDir
      pure [(market, date) | market <- markets, date <- range]
    else do
      let stripper path =
            let
              baseless = drop (length perpDir) path
              noExt = take (length baseless - 4) baseless
              (market, Prelude.tail -> date) = break (== '/') noExt
             in
              (market, Prelude.read date)

      collected <-
        C.runConduit $
          C.sourceDirectoryDeep False perpDir
            .| C.mapC stripper
            .| C.sinkList

      pure $
        [ (market, date)
        | market@PerpMarket {..} <- markets
        , date <- range
        , (toS baseAssetSymbol, date) `notElem` collected
        , utctDay (addUTCTime (secondsToNominalDiffTime $ fromInteger launchTs) unix)
            >= date
        ]


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


tradesOnDay
  :: ( C.MonadThrow m
     , C.MonadResource m
     , MonadError CsvParseError m
     )
  => PerpMarket
  -> Day
  -> m ()
tradesOnDay perp@PerpMarket {..} date = do
  let
    path = outDir <> "/" <> outFile
    outDir = "./data/perp-trades/" <> toS baseAssetSymbol
    outFile = formatTime defaultTimeLocale "%Y-%m-%d" date <> ".csv"

  bytes <- loadPerpTradesOnDay perp date

  case bytes of
    Nothing -> pure ()
    Just bytes ->
      C.runConduit $
        C.yield bytes
          .| fromNamedCsv @PerpTrade defaultDecodeOptions
          .| toCsv defaultEncodeOptions
          .| C.sinkFile path


loadPerpTradesOnDay :: MonadIO m => PerpMarket -> Day -> m (Maybe ByteString)
loadPerpTradesOnDay (PerpMarket {..}) date@(YearDay year _) = liftIO $ do
  putStrLn $ "Getting " <> symbol <> " trades on " <> show date
  req <- parseRequest url
  withRetries 5 req
  where
    baseUrl = "https://drift-historical-data-v2.s3.eu-west-1.amazonaws.com"
    program = "program/dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH"
    market = "market/" <> toS symbol
    file = formatTime defaultTimeLocale "%Y%m%d" date
    url = intercalate "/" [baseUrl, program, market, "tradeRecords", show year, file]

    withRetries :: C.MonadIO m => Int -> Request -> m (Maybe ByteString)
    withRetries tries req
      | tries <= 1 = liftIO $ do
          res <- httpBS req
          putStrLn @Text $
            "Failed to download\nRequest: " <> show req <> "Response: " <> show res
          pure Nothing
      | otherwise = do
          res <- httpBS req
          let status = getResponseStatusCode res
          if status == 404
            then pure Nothing
            else
              if status `div` 100 /= 2
                then do
                  microseconds <- liftIO $ randomRIO (500000, 3000000)
                  liftIO $ threadDelay microseconds
                  withRetries (tries - 1) req
                else pure $ Just $ getResponseBody res


data PerpTrade = PerpTrade
  { fillerReward :: Scientific
  -- ^ Reward received by the filler for filling the order.
  , baseAssetAmountFilled :: Scientific
  -- ^ Amount of the base asset filled in the order.
  , quoteAssetAmountFilled :: Scientific
  -- ^ Amount of the quote asset filled in the order.
  , takerFee :: Scientific
  -- ^ Fee charged to the taker for filling the order.
  , makerRebate :: Scientific
  -- ^ Rebate provided to the maker for placing the order.
  , referrerReward :: Scientific
  -- ^ Reward received by the referrer for referring the order.
  , quoteAssetAmountSurplus :: Scientific
  -- ^ Amount of the quote asset remaining unfilled after the order.
  , takerOrderBaseAssetAmount :: Scientific
  -- ^ Total amount of the base asset the taker ordered to buy or sell.
  , takerOrderCumulativeBaseAssetAmountFilled :: Scientific
  -- ^ Cumulative amount of the base asset filled for the taker's order.
  , takerOrderCumulativeQuoteAssetAmountFilled :: Scientific
  -- ^ Cumulative amount of the quote asset filled for the taker's order.
  , makerOrderBaseAssetAmount :: Scientific
  -- ^ Total amount of the base asset the maker ordered to buy or sell.
  , makerOrderCumulativeBaseAssetAmountFilled :: Scientific
  -- ^ Cumulative amount of the base asset filled for the maker's order.
  , makerOrderCumulativeQuoteAssetAmountFilled :: Scientific
  -- ^ Cumulative amount of the quote asset filled for the maker's order.
  , makerFee :: Scientific
  -- ^ Fee charged to the maker for placing the order (if not a maker rebate).
  , action :: Text
  -- ^ Action type for the order fill event (e.g., "Fill").
  , actionExplanation :: Text
  -- ^ Explanation of the action type.
  , filler :: Text
  -- ^ Address of the entity that filled the order.
  , fillRecordId :: Scientific
  -- ^ Unique identifier for the order fill record.
  , taker :: Text
  -- ^ Address of the taker who placed the order.
  , takerOrderId :: Maybe Scientific
  -- ^ Unique identifier for the taker's order.
  , takerOrderDirection :: Text
  -- ^ Direction of the taker's order (e.g., "Buy", "Sell").
  , maker :: Text
  -- ^ Address of the maker who placed the opposing order.
  , makerOrderId :: Maybe Scientific
  -- ^ Unique identifier for the maker's order.
  , makerOrderDirection :: Text
  -- ^ Direction of the maker's order (e.g., "Buy", "Sell").
  , spotFulfillmentMethodFee :: Scientific
  -- ^ Fee associated with the spot fulfillment method used.
  , -- Shared across all categories:
    ts :: Integer
  -- ^ Unix timestamp of the event (seconds since 1970).
  , txSig :: Text
  -- ^ Transaction signature.
  , slot :: Integer
  -- ^ Slot number of the event.
  -- , user :: Text
  -- -- ^ Address of the user who placed the order.
  -- , amount :: Integer
  -- -- ^ Amount of the base asset filled in the order.
  , programId :: Text
  -- ^ Solana program identifier (e.g., "AMM*").
  , marketType :: Text
  -- ^ Type of market where the order was filled (e.g., "Spot", "Perpetual").
  , marketIndex :: Integer
  -- ^ Index of the spot market.
  -- , perpMarketIndex :: Integer
  -- -- ^ Index of the perpetual contract market.
  -- , userAuthority :: Text
  -- -- ^ Public key of the user's authority account (wallet).
  , -- -- ^ Perpetual contract market index.
    -- , spotMarketIndex :: Integer

    oraclePrice :: Scientific
  -- ^ Oracle price at the time of an event (provided by Pyth/Switchboard).
  }
  deriving stock (Show, Generic)
  deriving anyclass (FromNamedRecord, ToRecord)
