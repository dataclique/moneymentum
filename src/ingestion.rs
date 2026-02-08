use std::path::PathBuf;
use std::sync::Arc;

use apalis::prelude::Data;
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use cqrs_es::{Aggregate, DomainEvent};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{error, info, warn};

use crate::hyperliquid::{CandleIngester, Hyperliquid};
use crate::lifecycle::{Lifecycle, LifecycleError, Never};
use crate::timeframe::Timeframe;
use crate::wire::{AggregateId, Cqrs, ViewTable};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct IngestionJob;

pub(crate) async fn handle_ingestion(
    _job: IngestionJob,
    cqrs: Data<Arc<Cqrs<Ingestion>>>,
    services: Data<Arc<IngestionServices>>,
) {
    if let Err(err) = cqrs
        .execute::<IngestionId>((), IngestionCommand::Start)
        .await
    {
        warn!(error = %err, "failed to start ingestion");
        return;
    }

    let ingester = CandleIngester::new(Arc::clone(&services.hyperliquid));
    let mut last_record = Utc::now();

    for timeframe in [
        Timeframe::FifteenMin,
        Timeframe::OneHour,
        Timeframe::OneDay,
        Timeframe::OneWeek,
    ] {
        match ingester.ingest(timeframe, &services.data_dir).await {
            Ok(()) => {
                last_record = Utc::now();
            }
            Err(err) => {
                warn!(error = %err, "ingestion failed");
                if let Err(err) = cqrs
                    .execute::<IngestionId>(
                        (),
                        IngestionCommand::Fail {
                            reason: err.to_string(),
                        },
                    )
                    .await
                {
                    error!(error = %err, "failed to record ingestion failure");
                }
                return;
            }
        }
    }

    info!("ingestion complete");
    if let Err(err) = cqrs
        .execute::<IngestionId>((), IngestionCommand::Complete { last_record })
        .await
    {
        error!(error = %err, "failed to record ingestion completion");
    }
}

/// Type-safe aggregate ID for the singleton ingestion process.
pub(crate) struct IngestionId;

impl AggregateId<Ingestion> for IngestionId {
    type Args = ();

    fn aggregate_id((): ()) -> String {
        "perp:hyperliquid".into()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum IngestionStatus {
    Running,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct IngestionState {
    pub(crate) status: IngestionStatus,
}

pub(crate) type Ingestion = Lifecycle<IngestionState, Never>;

#[derive(Debug, Serialize, Deserialize)]
pub(crate) enum IngestionCommand {
    Start,
    Complete { last_record: DateTime<Utc> },
    Fail { reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) enum IngestionEvent {
    Started {
        started_at: chrono::DateTime<chrono::Utc>,
    },
    Completed {
        last_record: chrono::DateTime<chrono::Utc>,
    },
    Failed {
        reason: String,
    },
}

impl DomainEvent for IngestionEvent {
    fn event_type(&self) -> String {
        match self {
            Self::Started { .. } => "Started".to_string(),
            Self::Completed { .. } => "Completed".to_string(),
            Self::Failed { .. } => "Failed".to_string(),
        }
    }

    fn event_version(&self) -> String {
        "1.0".to_string()
    }
}

#[derive(Debug, Error)]
pub(crate) enum IngestionError {
    #[error("ingestion already running")]
    AlreadyRunning,
}

pub(crate) struct IngestionServices {
    pub(crate) hyperliquid: Arc<dyn Hyperliquid>,
    pub(crate) data_dir: PathBuf,
}

#[async_trait]
impl Aggregate for Ingestion {
    type Command = IngestionCommand;
    type Event = IngestionEvent;
    type Error = IngestionError;
    type Services = IngestionServices;

    fn aggregate_type() -> String {
        "ingestion".to_string()
    }

    async fn handle(
        &self,
        command: Self::Command,
        _services: &Self::Services,
    ) -> Result<Vec<Self::Event>, Self::Error> {
        match command {
            IngestionCommand::Start => {
                let is_running = matches!(
                    self,
                    Self::Live(IngestionState {
                        status: IngestionStatus::Running
                    })
                );
                if is_running {
                    return Err(IngestionError::AlreadyRunning);
                }

                Ok(vec![IngestionEvent::Started {
                    started_at: Utc::now(),
                }])
            }
            IngestionCommand::Complete { last_record } => {
                Ok(vec![IngestionEvent::Completed { last_record }])
            }
            IngestionCommand::Fail { reason } => Ok(vec![IngestionEvent::Failed { reason }]),
        }
    }

    fn apply(&mut self, event: Self::Event) {
        *self = self
            .clone()
            .transition(&event, |incoming, current| match incoming {
                IngestionEvent::Started { .. } => {
                    // Started is only valid from Completed or Failed states (restart)
                    if current.status == IngestionStatus::Running {
                        Err(LifecycleError::AlreadyInitialized)
                    } else {
                        Ok(IngestionState {
                            status: IngestionStatus::Running,
                        })
                    }
                }
                IngestionEvent::Completed { .. } => Ok(IngestionState {
                    status: IngestionStatus::Completed,
                }),
                IngestionEvent::Failed { .. } => Ok(IngestionState {
                    status: IngestionStatus::Failed,
                }),
            })
            .or_initialize(&event, |incoming| match incoming {
                IngestionEvent::Started { .. } => Ok(IngestionState {
                    status: IngestionStatus::Running,
                }),
                _ => Err(LifecycleError::Uninitialized),
            });
    }
}

impl ViewTable for Ingestion {
    const TABLE: &'static str = "ingestion_view";
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use chrono::{DateTime, TimeZone, Utc};
    use cqrs_es::test::TestFramework;
    use proptest::prelude::*;

    use super::*;
    use crate::candle::Candle;
    use crate::finance::{Market, Symbol};
    use crate::hyperliquid::HyperliquidError;
    use crate::timeframe::Timeframe;

    type IngestionTestFramework = TestFramework<Ingestion>;

    struct MockHyperliquid;

    #[async_trait]
    impl Hyperliquid for MockHyperliquid {
        async fn list_markets(&self) -> Result<Vec<Market>, HyperliquidError> {
            Ok(vec![Market::new("BTC".into())])
        }

        async fn fetch_candles(
            &self,
            market: &Market,
            _timeframe: Timeframe,
            _start: DateTime<Utc>,
        ) -> Result<Vec<Candle>, HyperliquidError> {
            Ok(vec![Candle {
                timestamp: Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap(),
                open: 100.0,
                high: 105.0,
                low: 95.0,
                close: 102.0,
                volume: 1000.0,
                symbol: Symbol::from_raw(market.as_str()),
            }])
        }
    }

    fn sample_started() -> IngestionEvent {
        IngestionEvent::Started {
            started_at: Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap(),
        }
    }

    fn sample_completed() -> IngestionEvent {
        IngestionEvent::Completed {
            last_record: Utc.with_ymd_and_hms(2024, 1, 1, 1, 0, 0).unwrap(),
        }
    }

    fn test_services() -> IngestionServices {
        IngestionServices {
            hyperliquid: Arc::new(MockHyperliquid),
            data_dir: std::env::temp_dir(),
        }
    }

    #[test]
    fn start_emits_started() {
        let events = IngestionTestFramework::with(test_services())
            .given_no_previous_events()
            .when(IngestionCommand::Start)
            .inspect_result()
            .expect("should emit events");

        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], IngestionEvent::Started { .. }));
    }

    #[test]
    fn complete_emits_completed() {
        let last_record = Utc.with_ymd_and_hms(2024, 1, 1, 2, 0, 0).unwrap();
        let events = IngestionTestFramework::with(test_services())
            .given(vec![sample_started()])
            .when(IngestionCommand::Complete { last_record })
            .inspect_result()
            .expect("should emit events");

        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], IngestionEvent::Completed { .. }));
    }

    #[test]
    fn fail_emits_failed() {
        let events = IngestionTestFramework::with(test_services())
            .given(vec![sample_started()])
            .when(IngestionCommand::Fail {
                reason: "connection timeout".to_string(),
            })
            .inspect_result()
            .expect("should emit events");

        assert_eq!(events.len(), 1);
        assert!(
            matches!(&events[0], IngestionEvent::Failed { reason } if reason == "connection timeout")
        );
    }

    #[test]
    fn start_when_running_returns_error() {
        IngestionTestFramework::with(test_services())
            .given(vec![sample_started()])
            .when(IngestionCommand::Start)
            .then_expect_error_message("ingestion already running");
    }

    #[test]
    fn can_restart_after_completion() {
        let events = IngestionTestFramework::with(test_services())
            .given(vec![sample_started(), sample_completed()])
            .when(IngestionCommand::Start)
            .inspect_result()
            .expect("should emit events");

        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], IngestionEvent::Started { .. }));
    }

    #[test]
    fn can_restart_after_failure() {
        let events = IngestionTestFramework::with(test_services())
            .given(vec![
                sample_started(),
                IngestionEvent::Failed {
                    reason: "oops".to_string(),
                },
            ])
            .when(IngestionCommand::Start)
            .inspect_result()
            .expect("should emit events");

        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], IngestionEvent::Started { .. }));
    }

    #[test]
    fn apply_replays_event_sequence_to_correct_state() {
        use cqrs_es::Aggregate;

        let mut ingestion = Ingestion::default();

        // Apply Started -> should be Running
        ingestion.apply(sample_started());
        let state = ingestion.live().expect("should be live after Started");
        assert_eq!(state.status, IngestionStatus::Running);

        // Apply Completed -> should be Completed
        ingestion.apply(sample_completed());
        let state = ingestion.live().expect("should be live after Completed");
        assert_eq!(state.status, IngestionStatus::Completed);

        // Apply Started again (restart) -> should be Running
        ingestion.apply(IngestionEvent::Started {
            started_at: Utc.with_ymd_and_hms(2024, 1, 2, 0, 0, 0).unwrap(),
        });
        let state = ingestion.live().expect("should be live after restart");
        assert_eq!(state.status, IngestionStatus::Running);
    }

    fn arbitrary_timestamp() -> impl Strategy<Value = DateTime<Utc>> {
        (0i64..1_000_000_000_000i64).prop_map(|milliseconds| {
            DateTime::from_timestamp_millis(milliseconds)
                .unwrap_or_else(|| Utc.with_ymd_and_hms(2024, 1, 1, 0, 0, 0).unwrap())
        })
    }

    proptest! {
        #[test]
        fn started_on_uninitialized_results_in_running(timestamp in arbitrary_timestamp()) {
            use cqrs_es::Aggregate;

            let mut ingestion = Ingestion::default();
            ingestion.apply(IngestionEvent::Started { started_at: timestamp });

            let state = ingestion.live().expect("should be live after Started");
            prop_assert_eq!(state.status, IngestionStatus::Running);
        }

        #[test]
        fn completed_after_started_results_in_completed(
            started_at in arbitrary_timestamp(),
            last_record in arbitrary_timestamp(),
        ) {
            use cqrs_es::Aggregate;

            let mut ingestion = Ingestion::default();
            ingestion.apply(IngestionEvent::Started { started_at });
            ingestion.apply(IngestionEvent::Completed { last_record });

            let state = ingestion.live().expect("should be live after Completed");
            prop_assert_eq!(state.status, IngestionStatus::Completed);
        }

        #[test]
        fn failed_after_started_results_in_failed(
            started_at in arbitrary_timestamp(),
            reason in ".*",
        ) {
            use cqrs_es::Aggregate;

            let mut ingestion = Ingestion::default();
            ingestion.apply(IngestionEvent::Started { started_at });
            ingestion.apply(IngestionEvent::Failed { reason });

            let state = ingestion.live().expect("should be live after Failed");
            prop_assert_eq!(state.status, IngestionStatus::Failed);
        }

        #[test]
        fn restart_from_completed_results_in_running(
            first_started in arbitrary_timestamp(),
            completed_at in arbitrary_timestamp(),
            second_started in arbitrary_timestamp(),
        ) {
            use cqrs_es::Aggregate;

            let mut ingestion = Ingestion::default();
            ingestion.apply(IngestionEvent::Started { started_at: first_started });
            ingestion.apply(IngestionEvent::Completed { last_record: completed_at });
            ingestion.apply(IngestionEvent::Started { started_at: second_started });

            let state = ingestion.live().expect("should be live after restart");
            prop_assert_eq!(state.status, IngestionStatus::Running);
        }

        #[test]
        fn restart_from_failed_results_in_running(
            first_started in arbitrary_timestamp(),
            reason in ".*",
            second_started in arbitrary_timestamp(),
        ) {
            use cqrs_es::Aggregate;

            let mut ingestion = Ingestion::default();
            ingestion.apply(IngestionEvent::Started { started_at: first_started });
            ingestion.apply(IngestionEvent::Failed { reason });
            ingestion.apply(IngestionEvent::Started { started_at: second_started });

            let state = ingestion.live().expect("should be live after restart from failed");
            prop_assert_eq!(state.status, IngestionStatus::Running);
        }
    }
}
