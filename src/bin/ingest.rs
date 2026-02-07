use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};
use moneymentum::ingestion::{
    CandleIngester, HyperliquidClient, IngestionError, ParquetStorage,
    Timeframe as IngestionTimeframe,
};

#[derive(Parser)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Candles {
        #[arg(long)]
        timeframe: Timeframe,
        #[arg(long, default_value = "data")]
        data_dir: PathBuf,
    },
    Funding {
        #[arg(long, default_value = "data")]
        data_dir: PathBuf,
    },
}

#[derive(Clone, Copy, ValueEnum)]
enum Timeframe {
    #[value(name = "15m")]
    FifteenMin,
    #[value(name = "1h")]
    OneHour,
    #[value(name = "1d")]
    OneDay,
    #[value(name = "1w")]
    OneWeek,
}

impl From<Timeframe> for IngestionTimeframe {
    fn from(timeframe: Timeframe) -> Self {
        match timeframe {
            Timeframe::FifteenMin => Self::FifteenMin,
            Timeframe::OneHour => Self::OneHour,
            Timeframe::OneDay => Self::OneDay,
            Timeframe::OneWeek => Self::OneWeek,
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), IngestionError> {
    let cli = Cli::parse();

    match cli.command {
        Command::Candles {
            timeframe,
            data_dir,
        } => {
            let client = HyperliquidClient::new().await?;
            let storage = ParquetStorage {
                data_dir: data_dir.clone(),
            };
            let ingester = CandleIngester::new(client, storage);

            ingester.ingest(timeframe.into(), &data_dir).await?;

            println!("Candle ingestion complete");
        }
        Command::Funding { data_dir: _ } => {
            todo!("Funding rate ingestion not yet implemented");
        }
    }

    Ok(())
}
