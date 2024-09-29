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
  secondsToNominalDiffTime,
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
