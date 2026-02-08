use cqrs_es::event_sink::EventSink;
use cqrs_es::{Aggregate, DomainEvent};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::lifecycle::{Lifecycle, LifecycleError, Never};
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

pub(crate) struct IngestionServices;

impl Aggregate for Ingestion {
    const TYPE: &'static str = "ingestion";
    type Command = IngestionCommand;
    type Event = IngestionEvent;
    type Error = IngestionError;
    type Services = IngestionServices;

    async fn handle(
        &mut self,
        command: Self::Command,
        _services: &Self::Services,
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
            }
        }
        Ok(())
    }

    fn apply(&mut self, event: Self::Event) {
        *self = self
            .clone()
            .transition(&event, |ev, _| match ev {
                IngestionEvent::Started { .. } => Err(LifecycleError::AlreadyInitialized),
                IngestionEvent::Completed { .. } => Ok(IngestionState {
                    status: IngestionStatus::Completed,
                }),
                IngestionEvent::Failed { .. } => Ok(IngestionState {
                    status: IngestionStatus::Failed,
                }),
            })
            .or_initialize(&event, |ev| match ev {
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
    use super::*;
    use chrono::{TimeZone, Utc};
    use cqrs_es::test::TestFramework;

    type IngestionTestFramework = TestFramework<Ingestion>;

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

    #[test]
    fn start_when_running_returns_error() {
        let services = IngestionServices;
        IngestionTestFramework::with(services)
            .given(vec![sample_started()])
            .when(IngestionCommand::Start)
            .then_expect_error_message("ingestion already running");
    }

    #[test]
    fn can_restart_after_completion() {
        let services = IngestionServices;
        let events = IngestionTestFramework::with(services)
            .given(vec![sample_started(), sample_completed()])
            .when(IngestionCommand::Start)
            .inspect_result()
            .expect("should emit events");

        assert_eq!(events.len(), 1);
        assert!(matches!(events[0], IngestionEvent::Started { .. }));
    }

    #[test]
    fn can_restart_after_failure() {
        let services = IngestionServices;
        let events = IngestionTestFramework::with(services)
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
}
