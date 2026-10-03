//! Server-side XRender scaling keeps full-size frames off the client encoding path.
use crate::{
    protocol::{Fault, Result, internal},
    x11::X11,
};
use std::sync::Arc;
use x11rb::protocol::render::ConnectionExt as _;
use x11rb::protocol::xproto::ConnectionExt as _;
use x11rb::{
    connection::Connection,
    protocol::{render::*, xproto::*},
};
pub struct Scaled {
    conn: Arc<X11>,
    source: u32,
    destination: u32,
    pixmap: u32,
    pub size: (u16, u16, u16, u16),
    pub visual: u32,
}
impl Scaled {
    pub fn new(
        conn: Arc<X11>,
        window: u32,
        visual: u32,
        input: (u16, u16),
        output: (u16, u16),
    ) -> Result<Self> {
        let formats = conn
            .conn
            .render_query_pict_formats()
            .map_err(internal)?
            .reply()
            .map_err(internal)?;
        let root = conn
            .conn
            .setup()
            .roots
            .iter()
            .find(|r| r.root == conn.root)
            .ok_or_else(|| internal("Missing root"))?;
        let find = |visual: u32| {
            formats
                .screens
                .iter()
                .flat_map(|s| &s.depths)
                .flat_map(|d| &d.visuals)
                .find(|v| v.visual == visual)
                .map(|v| v.format)
                .ok_or_else(|| Fault::new("not_supported", "XRender visual unavailable"))
        };
        let source_format = find(visual)?;
        let dest_format = find(root.root_visual)?;
        let pixmap = conn.conn.generate_id().map_err(internal)?;
        let source = conn.conn.generate_id().map_err(internal)?;
        let destination = conn.conn.generate_id().map_err(internal)?;
        conn.conn
            .create_pixmap(root.root_depth, pixmap, conn.root, output.0, output.1)
            .map_err(internal)?
            .check()
            .map_err(internal)?;
        let result = (|| {
            conn.conn
                .render_create_picture(
                    source,
                    window,
                    source_format,
                    &CreatePictureAux::new().subwindowmode(SubwindowMode::INCLUDE_INFERIORS),
                )
                .map_err(internal)?
                .check()
                .map_err(internal)?;
            conn.conn
                .render_create_picture(destination, pixmap, dest_format, &CreatePictureAux::new())
                .map_err(internal)?
                .check()
                .map_err(internal)?;
            let transform = Transform {
                matrix11: (i64::from(input.0) * 65536 / i64::from(output.0)) as i32,
                matrix12: 0,
                matrix13: 0,
                matrix21: 0,
                matrix22: (i64::from(input.1) * 65536 / i64::from(output.1)) as i32,
                matrix23: 0,
                matrix31: 0,
                matrix32: 0,
                matrix33: 65536,
            };
            conn.conn
                .render_set_picture_transform(source, transform)
                .map_err(internal)?
                .check()
                .map_err(internal)?;
            conn.conn
                .render_set_picture_filter(source, b"bilinear", &[])
                .map_err(internal)?
                .check()
                .map_err(internal)?;
            Ok(())
        })();
        if let Err(e) = result {
            let _ = conn.conn.render_free_picture(source);
            let _ = conn.conn.render_free_picture(destination);
            let _ = conn.conn.free_pixmap(pixmap);
            return Err(e);
        }
        let root_visual = root.root_visual;
        Ok(Self {
            conn,
            source,
            destination,
            pixmap,
            size: (input.0, input.1, output.0, output.1),
            visual: root_visual,
        })
    }
    pub fn render(&self) -> Result<u32> {
        self.conn
            .conn
            .render_composite(
                PictOp::SRC,
                self.source,
                0u32,
                self.destination,
                0,
                0,
                0,
                0,
                0,
                0,
                self.size.2,
                self.size.3,
            )
            .map_err(internal)?
            .check()
            .map_err(internal)?;
        Ok(self.pixmap)
    }
}
impl Drop for Scaled {
    fn drop(&mut self) {
        let _ = self.conn.conn.render_free_picture(self.source);
        let _ = self.conn.conn.render_free_picture(self.destination);
        let _ = self.conn.conn.free_pixmap(self.pixmap);
        let _ = self.conn.conn.flush();
    }
}
