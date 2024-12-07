from pyspark.sql import SparkSession
from pyspark.sql import types as T

spark = SparkSession.builder.appName("pipeline").getOrCreate()
spark.sparkContext.setLogLevel("ERROR")

ohlcv_dir = "data/hyperliquid/ohlcv"

SchemaOHLCV = T.StructType(
    [
        T.StructField("timestamp", T.TimestampType()),
        T.StructField("open", T.DoubleType()),
        T.StructField("high", T.DoubleType()),
        T.StructField("low", T.DoubleType()),
        T.StructField("close", T.DoubleType()),
        T.StructField("volume", T.DoubleType()),
    ]
)


btc_df = (
    spark.read.schema(SchemaOHLCV)
    .option("multiLine", "true")
    .json(f"{ohlcv_dir}/BTC_USDC_USDC_ohlcv.json")
)
btc_df.show()
