module Main (main) where

import Conduit ((.|))
import Conduit qualified as C
import Control.Concurrent.Async (forConcurrently_)
import Data.Aeson
import Data.ByteString.Lazy qualified as BSL
import Data.Time (
  UTCTime (UTCTime, utctDay),
  addUTCTime,
  getCurrentTime,
  secondsToNominalDiffTime, addDays,
 )
import Data.Time.Calendar (fromGregorian)
import Data.Time.Calendar.OrdinalDate
import Protolude hiding (yield)
import Quant.Perp.Market
import Quant.Perp.Trade
import System.Directory qualified as Dir
import Prelude qualified


main :: IO ()
main = do
  let startDay = fromGregorian 2024 1 1

  markets <- loadPerpMarkets
  tasks <- C.runResourceT $ getTasks startDay markets

  forConcurrently_ markets \market ->
    run $
      C.yieldMany (filter ((== market) . fst) tasks)
        .| C.iterMC (uncurry tradesOnDay)
        .| C.sinkNull

  yesterday <- getYesterday
  let startDay = addDays (-35) yesterday

  tradeDays <- C.runResourceT $ getSavedTradeDays markets [startDay .. yesterday]

  forM_ markets \perp@PerpMarket {baseAssetSymbol} ->
    print (baseAssetSymbol, length $ filter ((== perp) . fst) tradeDays)

  where
    run = C.runResourceT . (either print pure <=< runExceptT . C.runConduit)

loadPerpMarkets :: MonadIO m => m [PerpMarket]
loadPerpMarkets = liftIO do
  let path = "./drift-perp-markets.json"
  Data.Aeson.decode @[PerpMarket]
    <$> BSL.readFile path >>= \case
      Nothing -> panic "Failed to parse markets"
      Just markets -> pure markets

getYesterday :: MonadIO m => m Day
getYesterday = do
  UTCTime day _ <- liftIO getCurrentTime
  pure $ addDays (-1) day

perpDir :: FilePath
perpDir = "data/perp-trades/"

getTasks
  :: ( C.MonadThrow m
     , C.MonadResource m
     )
  => Day
  -> [PerpMarket]
  -> m [(PerpMarket, Day)]
getTasks startDay markets = do
  endDay <- getYesterday
  let range = Prelude.init [startDay .. endDay]

  perpDirExists <- liftIO $ Dir.doesDirectoryExist perpDir

  forM_ markets \PerpMarket {..} -> do
    let outDir = "./data/perp-trades/" <> toS baseAssetSymbol
    liftIO $ Dir.createDirectoryIfMissing True outDir

  if not perpDirExists
    then do
      liftIO $ Dir.createDirectoryIfMissing True perpDir
      pure [(market, date) | market <- markets, date <- range]
    else getSavedTradeDays markets range

getSavedTradeDays :: C.MonadResource f => [PerpMarket] -> [Day] -> f [(PerpMarket, Day)]
getSavedTradeDays markets range = do
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

  let unix = UTCTime (fromGregorian 1970 1 1) 0

  pure $
    [ (market, date)
    | market@PerpMarket {..} <- markets
    , date <- range
    , (toS baseAssetSymbol, date) `notElem` collected
    , utctDay (addUTCTime (secondsToNominalDiffTime $ fromInteger launchTs) unix)
        >= date
    ]
