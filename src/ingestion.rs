use std::path::PathBuf;
use std::sync::Arc;

use cqrs_es::event_sink::EventSink;
use cqrs_es::{Aggregate, DomainEvent};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::hyperliquid::{CandleIngester, Hyperliquid};
use crate::lifecycle::{Lifecycle, LifecycleError, Never};
use crate::timeframe::Timeframe;
use crate::wire::{AggregateId, ViewTable};

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

impl Aggregate for Ingestion {
    const TYPE: &'static str = "ingestion";
    type Command = IngestionCommand;
    type Event = IngestionEvent;
    type Error = IngestionError;
    type Services = IngestionServices;

    async fn handle(
        &mut self,
        command: Self::Command,
        services: &Self::Services,
        sink: &EventSink<Self>,
    ) -> Result<(), Self::Error> {
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

                sink.write(
                    IngestionEvent::Started {
                        started_at: chrono::Utc::now(),
                    },
                    self,
                )
                .await;

                let ingester = CandleIngester::new(Arc::clone(&services.hyperliquid));
                let mut last_record = chrono::Utc::now();

                for timeframe in [
                    Timeframe::FifteenMin,
                    Timeframe::OneHour,
                    Timeframe::OneDay,
                    Timeframe::OneWeek,
                ] {
                    match ingester.ingest(timeframe, &services.data_dir).await {
                        Ok(()) => {
                            last_record = chrono::Utc::now();
                        }
                        Err(error) => {
                            sink.write(
                                IngestionEvent::Failed {
                                    reason: error.to_string(),
                                },
                                self,
                            )
                            .await;
                            return Ok(());
                        }
                    }
                }

                sink.write(IngestionEvent::Completed { last_record }, self)
                    .await;
            }
        }
        Ok(())
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
    use crate::finance::Market;
    use crate::hyperliquid::HyperliquidError;
    use crate::timeframe::Timeframe;

    type IngestionTestFramework = TestFramework<Ingestion>;

    struct MockHyperliquid {
        should_fail: bool,
    }

    #[async_trait]
    impl Hyperliquid for MockHyperliquid {
        async fn list_markets(&self) -> Result<Vec<Market>, HyperliquidError> {
            if self.should_fail {
                Err(HyperliquidError::Sdk(
                    hyperliquid_rust_sdk::Error::GenericRequest("mock error".into()),
                ))
            } else {
                Ok(vec![Market::new("BTC".into())])
            }
        }

        async fn fetch_candles(
            &self,
            _market: &Market,
            _timeframe: Timeframe,
            _start: DateTime<Utc>,
        ) -> Result<Vec<Candle>, HyperliquidError> {
            Ok(vec![])
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

    fn services_that_succeed() -> IngestionServices {
        IngestionServices {
            hyperliquid: Arc::new(MockHyperliquid { should_fail: false }),
            data_dir: std::env::temp_dir(),
        }
    }

    fn services_that_fail() -> IngestionServices {
        IngestionServices {
            hyperliquid: Arc::new(MockHyperliquid { should_fail: true }),
            data_dir: std::env::temp_dir(),
        }
    }

    #[test]
    fn start_emits_started_then_completed_on_success() {
        let events = IngestionTestFramework::with(services_that_succeed())
            .given_no_previous_events()
            .when(IngestionCommand::Start)
            .inspect_result()
            .expect("should emit events");

        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], IngestionEvent::Started { .. }));
        assert!(matches!(events[1], IngestionEvent::Completed { .. }));
    }

    #[test]
    fn start_emits_started_then_failed_on_error() {
        let events = IngestionTestFramework::with(services_that_fail())
            .given_no_previous_events()
            .when(IngestionCommand::Start)
            .inspect_result()
            .expect("should emit events");

        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], IngestionEvent::Started { .. }));
        assert!(matches!(events[1], IngestionEvent::Failed { .. }));
    }

    #[test]
    fn start_when_running_returns_error() {
        IngestionTestFramework::with(services_that_succeed())
            .given(vec![sample_started()])
            .when(IngestionCommand::Start)
            .then_expect_error_message("ingestion already running");
    }

    #[test]
    fn can_restart_after_completion() {
        let events = IngestionTestFramework::with(services_that_succeed())
            .given(vec![sample_started(), sample_completed()])
            .when(IngestionCommand::Start)
            .inspect_result()
            .expect("should emit events");

        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], IngestionEvent::Started { .. }));
        assert!(matches!(events[1], IngestionEvent::Completed { .. }));
    }

    #[test]
    fn can_restart_after_failure() {
        let events = IngestionTestFramework::with(services_that_succeed())
            .given(vec![
                sample_started(),
                IngestionEvent::Failed {
                    reason: "oops".to_string(),
                },
            ])
            .when(IngestionCommand::Start)
            .inspect_result()
            .expect("should emit events");

        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], IngestionEvent::Started { .. }));
        assert!(matches!(events[1], IngestionEvent::Completed { .. }));
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
