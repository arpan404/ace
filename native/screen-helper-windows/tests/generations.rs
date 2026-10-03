use ace_screen_helper_windows::{codec::Header, mailbox::Mailbox, stream::Stream};
fn header(packet: &[u8]) -> Header {
    let size = u32::from_be_bytes(packet[..4].try_into().unwrap()) as usize;
    serde_json::from_slice(&packet[4..4 + size]).unwrap()
}
#[test]
fn retirement_discards_pending_and_in_flight_generations_without_truncating_packets() {
    let mut stream = Stream::new("old".into(), 2, 10);
    stream.generation(1);
    let old = stream.frame(&[0; 12], 2, 2, 1.0, 0.0).unwrap().unwrap();
    let mut queue = Mailbox::default();
    queue.activate(1);
    assert!(queue.publish(1, old.clone()));
    let writing = queue.take().unwrap();
    assert!(queue.publish(1, old));
    queue.retire();
    assert!(queue.take().is_none());
    assert!(!queue.current(writing.generation));
    queue.activate(2);
    stream.generation(2);
    let fresh = stream.frame(&[0; 12], 2, 2, 1.0, 100.0).unwrap().unwrap();
    assert!(!queue.publish(1, writing.bytes.clone()));
    assert!(queue.publish(2, fresh));
    let packet = queue.take().unwrap();
    assert_eq!(header(&writing.bytes).capture_generation, Some(1));
    assert_eq!(header(&packet.bytes).capture_generation, Some(2));
    assert!(queue.current(packet.generation));
}
#[test]
fn unchanged_pixels_still_emit_changed_coordinate_metadata() {
    let mut stream = Stream::new("s".into(), 2, 10);
    stream.generation(1);
    assert!(stream.frame(&[0; 12], 2, 2, 1.0, 0.0).unwrap().is_some());
    assert!(stream.frame(&[0; 12], 2, 2, 2.0, 50.0).unwrap().is_none());
    let packet = stream.frame(&[0; 12], 2, 2, 2.0, 100.0).unwrap().unwrap();
    assert_eq!(header(&packet).scale, 2.0);
    assert_eq!(header(&packet).seq, 1);
    assert!(stream.frame(&[0; 12], 2, 2, 2.0, 200.0).unwrap().is_none());
}
#[test]
fn duplicate_events_are_paced_without_losing_the_next_change() {
    let mut stream = Stream::new("s".into(), 2, 10);
    assert!(stream.frame(&[0; 12], 2, 2, 1.0, 0.0).unwrap().is_some());
    assert!(stream.frame(&[0; 12], 2, 2, 1.0, 100.0).unwrap().is_none());
    assert_eq!(stream.due_in(150.0), 50.0);
    assert!(stream.frame(&[1; 12], 2, 2, 1.0, 150.0).unwrap().is_none());
    let packet = stream.frame(&[1; 12], 2, 2, 1.0, 200.0).unwrap().unwrap();
    assert_eq!(header(&packet).seq, 1);
}
#[test]
fn the_final_capture_event_keeps_a_deadline_without_resubmitting_the_frame() {
    use ace_screen_helper_windows::capture_wait::{Pending, Wait};
    let mut pending = Pending::default();
    assert_eq!(pending.next(0.0), Wait::Idle);
    pending.arrived();
    assert_eq!(pending.next(80.0), Wait::After(80.0));
    assert_eq!(pending.next(10.0), Wait::After(10.0));
    assert_eq!(pending.next(0.0), Wait::Frame);
    assert_eq!(pending.next(0.0), Wait::Idle);
    pending.arrived();
    pending.arrived();
    assert_eq!(pending.next(0.0), Wait::Frame);
    assert_eq!(pending.next(0.0), Wait::Idle);
}
