/* Fresh ABI shell around the installed PipeWire library; no executable subprocesses. */
#include <pipewire/pipewire.h>
#include <spa/param/video/format-utils.h>
/* PipeWire 0.3.19 (Debian 11, the release build's floor) keeps the buffers params in param.h. */
#if __has_include(<spa/param/buffers.h>)
#include <spa/param/buffers.h>
#else
#include <spa/param/param.h>
#endif
#include <spa/buffer/meta.h>
#include <dlfcn.h>
#include <stdint.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <errno.h>
#include <stdlib.h>
#include <stdio.h>

/* One picture as the producer handed it over: mapped memory, or a DMA-BUF the consumer
 * imports. Valid only during the callback. */
struct ace_pw_picture {
    int dmabuf;
    const unsigned char *bytes;
    int fd;
    unsigned offset, width, height;
    int stride;
    unsigned format;
    uint64_t modifier;
    int has_crop, crop_x, crop_y;
    unsigned crop_w, crop_h;
};
struct capture {
    void *library;
    struct pw_main_loop *loop;
    struct pw_context *context;
    struct pw_core *core;
    struct pw_stream *stream;
    struct spa_hook listener;
    struct spa_source *wakeup;
    struct spa_video_info_raw video;
    /* The valid region of the last buffer (VideoCrop meta), when the producer sent one. */
    int has_crop;
    int crop_x, crop_y;
    unsigned crop_w, crop_h;
    int (*update_params)(struct pw_stream *, const struct spa_pod **, unsigned);
    int (*frame)(void *, const struct ace_pw_picture *);
    void *user;
    /* DMA-BUFs were offered, and the producer chose them. */
    int offer_dmabuf, dmabuf;
    /* A buffer the consumer keeps until its frame rate allows it; returned to the producer
     * once a newer one replaces it or it has been used. */
    struct pw_buffer *held;
    /* Buffers PipeWire refused back (reported once). */
    unsigned refused;
    int failed;
    struct pw_buffer *(*dequeue)(struct pw_stream *);
    int (*queue)(struct pw_stream *, struct pw_buffer *);
    int (*iterate)(struct pw_loop *, int);
    struct pw_loop *(*get_loop)(struct pw_main_loop *);
    void (*stream_destroy)(struct pw_stream *);
    int (*disconnect)(struct pw_core *);
    void (*context_destroy)(struct pw_context *);
    void (*loop_destroy)(struct pw_main_loop *);
};
static void stop_ready(void *user, int fd, uint32_t mask) {
    (void)user; (void)mask;
    char byte;
    (void)read(fd, &byte, 1);
}
/* Asks for crop metadata (window streams mark the window's region inside a larger buffer),
 * and says which memory the buffers may be and, when `count` isn't 0, how many there are. */
/* Gives a buffer back to the producer. PipeWire refuses one that isn't this consumer's to
 * give (a removed buffer's slot, reused): said once, as it means a buffer was held too long. */
static void give_back(struct capture *c, struct pw_buffer *b) {
    if (c->queue(c->stream, b) < 0 && !c->refused++)
        fprintf(stderr, "capture: PipeWire refused a buffer handed back\n");
}
static void buffer_params(struct capture *c, int count) {
    unsigned char buffer[512];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    const struct spa_pod *params[2];
    params[0] = spa_pod_builder_add_object(&builder, SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta,
        SPA_PARAM_META_type, SPA_POD_Id(SPA_META_VideoCrop),
        SPA_PARAM_META_size, SPA_POD_Int(sizeof(struct spa_meta_region)));
    int types = c->dmabuf ? (1<<SPA_DATA_DmaBuf) : ((1<<SPA_DATA_MemFd)|(1<<SPA_DATA_MemPtr));
    params[1] = count
        ? spa_pod_builder_add_object(&builder, SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers,
            SPA_PARAM_BUFFERS_buffers, SPA_POD_Int(count),
            SPA_PARAM_BUFFERS_dataType, SPA_POD_CHOICE_FLAGS_Int(types))
        : spa_pod_builder_add_object(&builder, SPA_TYPE_OBJECT_ParamBuffers, SPA_PARAM_Buffers,
            SPA_PARAM_BUFFERS_dataType, SPA_POD_CHOICE_FLAGS_Int(types));
    if (c->update_params) c->update_params(c->stream, params, 2);
}
static void format_changed(void *user, unsigned id, const struct spa_pod *pod) {
    struct capture *c = user;
    if (id != SPA_PARAM_Format || !pod) return;
    /* A held buffer is of the old format, and PipeWire removes it next: give it back now, and
     * never read it with the new format's size. */
    if (c->held) { give_back(c, c->held); c->held = NULL; }
    if (spa_format_video_raw_parse(pod, &c->video) < 0 ||
        c->video.size.width > 8192 || c->video.size.height > 8192 ||
        (uint64_t)c->video.size.width*c->video.size.height > 16777216) { c->failed = 1; return; }
    /* A format with a modifier is the DMA-BUF one this consumer offered. */
    c->dmabuf = c->offer_dmabuf && (c->video.flags & SPA_VIDEO_FLAG_MODIFIER) != 0;
    buffer_params(c, 0);
}
static void state_changed(void *user, enum pw_stream_state old, enum pw_stream_state state, const char *error) {
    (void)old; (void)error;
    if (state == PW_STREAM_STATE_ERROR) ((struct capture *)user)->failed = 1;
}
/* The buffer's pixels, readable. PipeWire maps a buffer with the access its producer flagged,
 * and xdg-desktop-portal-hyprland flags its shared-memory buffers mappable but not readable,
 * so that mapping can't be read. Such a buffer is mapped read-only here instead (*mapped is
 * then the length to unmap), once the file is known to hold everything the producer claims. */
static unsigned char *readable(struct spa_data *d, size_t *mapped) {
    *mapped = 0;
    if (d->data && ((d->flags & SPA_DATA_FLAG_READABLE) || d->type == SPA_DATA_MemPtr))
        return d->data;
    if (d->type != SPA_DATA_MemFd || d->fd < 0 || !d->maxsize) return NULL;
    struct stat st;
    uint64_t length = (uint64_t)d->mapoffset + d->maxsize;
    if (fstat((int)d->fd, &st) != 0 || st.st_size < 0 || (uint64_t)st.st_size < length ||
        length > SIZE_MAX) return NULL;
    void *pixels = mmap(NULL, (size_t)length, PROT_READ, MAP_SHARED, (int)d->fd, 0);
    if (pixels == MAP_FAILED) return NULL;
    *mapped = (size_t)length;
    return (unsigned char *)pixels + d->mapoffset;
}
/* Hands one buffer to the consumer; returns whether it keeps the buffer for later. */
static int deliver(struct capture *c, struct pw_buffer *b) {
    if (c->failed || !b->buffer || b->buffer->n_datas == 0) return 0;
    struct ace_pw_picture p = {0};
    struct spa_meta_region *crop = spa_buffer_find_meta_data(b->buffer, SPA_META_VideoCrop, sizeof(*crop));
    c->has_crop = crop && spa_meta_region_is_valid(crop);
    if (c->has_crop) {
        c->crop_x = crop->region.position.x; c->crop_y = crop->region.position.y;
        c->crop_w = crop->region.size.width; c->crop_h = crop->region.size.height;
        p.has_crop = 1; p.crop_x = c->crop_x; p.crop_y = c->crop_y; p.crop_w = c->crop_w; p.crop_h = c->crop_h;
    }
    struct spa_data *d = &b->buffer->datas[0];
    unsigned w = c->video.size.width, h = c->video.size.height;
    p.width = w; p.height = h; p.format = c->video.format; p.modifier = c->video.modifier;
    if (!d->chunk || !w || !h || d->chunk->stride < (int)(w*4) || (d->chunk->flags & SPA_CHUNK_FLAG_CORRUPTED)) return 0;
    p.stride = d->chunk->stride; p.offset = d->chunk->offset;
    if (d->type == SPA_DATA_DmaBuf) {
        if (d->fd < 0) return 0;
        p.dmabuf = 1; p.fd = (int)d->fd;
        return c->frame(c->user, &p);
    }
    size_t mapped = 0;
    unsigned char *base = readable(d, &mapped);
    int keep = 0;
    if (base && d->chunk->offset <= d->maxsize && (uint64_t)d->chunk->stride*h <= d->maxsize-d->chunk->offset &&
        d->chunk->size >= (uint64_t)d->chunk->stride*(h-1)+w*4) {
        p.bytes = base + d->chunk->offset; p.fd = -1;
        keep = c->frame(c->user, &p);
    }
    if (mapped) munmap(base - d->mapoffset, mapped);
    return keep;
}
/* Delivers `b`; a buffer it keeps replaces the one held, one it doesn't goes back at once. */
static void offer(struct capture *c, struct pw_buffer *b) {
    if (deliver(c, b)) {
        if (c->held && c->held != b) give_back(c, c->held);
        c->held = b;
        return;
    }
    if (c->held && c->held != b) give_back(c, c->held);
    c->held = NULL;
    give_back(c, b);
}
static void process(void *user) {
    struct capture *c = user;
    /* Only the newest buffer matters: older ones go straight back. */
    struct pw_buffer *b, *newest = NULL;
    while ((b = c->dequeue(c->stream))) {
        if (newest) give_back(c, newest);
        newest = b;
    }
    if (newest) offer(c, newest);
}
/* PipeWire is removing a buffer (a new format, or new buffers): it is no longer held. */
static void buffer_removed(void *user, struct pw_buffer *b) {
    struct capture *c = user;
    if (c->held == b) c->held = NULL;
}
static const struct pw_stream_events events = {
    .version = PW_VERSION_STREAM_EVENTS, .state_changed = state_changed,
    .remove_buffer = buffer_removed,
    .param_changed = format_changed, .process = process
};
#define LOAD(member, name) do { *(void **)(&member) = dlsym(c->library,name); if (!member) goto fail; } while (0)
void ace_pw_destroy(struct capture *c) {
    if (!c) return;
    if (c->held && c->stream && c->queue) { c->queue(c->stream, c->held); c->held = NULL; }
    if (c->stream && c->stream_destroy) c->stream_destroy(c->stream);
    if (c->core && c->disconnect) c->disconnect(c->core);
    if (c->context && c->context_destroy) c->context_destroy(c->context);
    if (c->wakeup && c->loop) pw_loop_destroy_source(c->get_loop(c->loop),c->wakeup);
    if (c->loop && c->loop_destroy) c->loop_destroy(c->loop);
    if (c->library) dlclose(c->library);
    free(c);
}
/* The raw formats this helper reads; with `modifier` set, only as DMA-BUFs with that layout. */
static const struct spa_pod *video_format(struct spa_pod_builder *b, int dmabuf) {
    struct spa_pod_frame frame;
    spa_pod_builder_push_object(b, &frame, SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat);
    spa_pod_builder_add(b, SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video),
        SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
        SPA_FORMAT_VIDEO_format, SPA_POD_CHOICE_ENUM_Id(4,SPA_VIDEO_FORMAT_BGRx,SPA_VIDEO_FORMAT_BGRA,SPA_VIDEO_FORMAT_RGBx,SPA_VIDEO_FORMAT_RGBA), 0);
    if (dmabuf) {
        /* Linear: every importer (VA-API, EGL) reads it, so no modifier list is negotiated. */
        spa_pod_builder_prop(b, SPA_FORMAT_VIDEO_modifier, SPA_POD_PROP_FLAG_MANDATORY);
        spa_pod_builder_long(b, 0);
    }
    return spa_pod_builder_pop(b, &frame);
}
struct capture *ace_pw_open(int fd, unsigned node, int stop_fd, int dmabuf, int (*frame)(void *, const struct ace_pw_picture *), void *user) {
    struct capture *c = calloc(1,sizeof(*c));
    int remote = fd;
    if (!c) { close(fd); return NULL; }
    c->frame=frame; c->user=user; c->offer_dmabuf=dmabuf;
    c->library=dlopen("libpipewire-0.3.so.0",RTLD_NOW|RTLD_LOCAL);
    if (!c->library) goto fail;
    void (*init)(int *,char ***);
    struct pw_main_loop *(*loop_new)(const struct spa_dict *);
    struct pw_context *(*context_new)(struct pw_loop *,struct pw_properties *,size_t);
    struct pw_core *(*connect_fd)(struct pw_context *,int,struct pw_properties *,size_t);
    struct pw_stream *(*stream_new)(struct pw_core *,const char *,struct pw_properties *);
    void (*add_listener)(struct pw_stream *,struct spa_hook *,const struct pw_stream_events *,void *);
    int (*connect)(struct pw_stream *,enum pw_direction,unsigned,enum pw_stream_flags,const struct spa_pod **,unsigned);
    LOAD(init,"pw_init"); LOAD(loop_new,"pw_main_loop_new"); LOAD(c->get_loop,"pw_main_loop_get_loop");
    LOAD(context_new,"pw_context_new"); LOAD(connect_fd,"pw_context_connect_fd");
    LOAD(stream_new,"pw_stream_new"); LOAD(add_listener,"pw_stream_add_listener"); LOAD(connect,"pw_stream_connect");
    LOAD(c->dequeue,"pw_stream_dequeue_buffer"); LOAD(c->queue,"pw_stream_queue_buffer");
    LOAD(c->stream_destroy,"pw_stream_destroy"); LOAD(c->disconnect,"pw_core_disconnect");
    LOAD(c->context_destroy,"pw_context_destroy"); LOAD(c->loop_destroy,"pw_main_loop_destroy");
    *(void **)(&c->update_params) = dlsym(c->library,"pw_stream_update_params");
    init(NULL,NULL);
    c->loop=loop_new(NULL); if (!c->loop) goto fail;
    c->wakeup=pw_loop_add_io(c->get_loop(c->loop),stop_fd,SPA_IO_IN,false,stop_ready,c);
    if (!c->wakeup) goto fail;
    c->context=context_new(c->get_loop(c->loop),NULL,0); if (!c->context) goto fail;
    c->core=connect_fd(c->context,remote,NULL,0); remote=-1; if (!c->core) goto fail;
    c->stream=stream_new(c->core,"ace-screen",NULL); if (!c->stream) goto fail;
    add_listener(c->stream,&c->listener,&events,c);
    unsigned char buffer[1024];
    struct spa_pod_builder builder=SPA_POD_BUILDER_INIT(buffer,sizeof(buffer));
    /* DMA-BUFs first when the encoder imports them; shared memory always remains. */
    const struct spa_pod *formats[2];
    unsigned count=0;
    if (dmabuf) formats[count++]=video_format(&builder,1);
    formats[count++]=video_format(&builder,0);
    if (connect(c->stream,PW_DIRECTION_INPUT,node,PW_STREAM_FLAG_AUTOCONNECT|PW_STREAM_FLAG_MAP_BUFFERS,formats,count)<0) goto fail;
    return c;
fail:
    if (remote>=0) close(remote);
    ace_pw_destroy(c); return NULL;
}
int ace_pw_step(struct capture *c, int timeout) {
    if (c->failed) return -1;
    return pw_loop_iterate(c->get_loop(c->loop),timeout);
}
/* Offers the held buffer again (its frame rate now allows it). */
void ace_pw_redeliver(struct capture *c) {
    if (!c || !c->held) return;
    struct pw_buffer *b = c->held;
    c->held = NULL;
    offer(c, b);
}
/* Whether the producer sends DMA-BUFs. */
int ace_pw_dmabuf(struct capture *c) { return c && c->dmabuf; }
/* Offers shared memory only from now on: the producer renegotiates. */
void ace_pw_shared_memory_only(struct capture *c) {
    if (!c || !c->update_params || !c->offer_dmabuf) return;
    c->offer_dmabuf = 0;
    unsigned char buffer[512];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    const struct spa_pod *format = video_format(&builder, 0);
    c->update_params(c->stream, &format, 1);
}
/* Tests only (debug builds): offers the formats again, BGRx alone or all of them, so the stream
 * negotiates its format and PipeWire removes every buffer and allocates new ones, as a resize or
 * a move to shared memory does. */
void ace_pw_reallocate(struct capture *c, int narrow) {
    if (!c || !c->update_params) return;
    unsigned char buffer[1024];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    const struct spa_pod *format = narrow
        ? spa_pod_builder_add_object(&builder, SPA_TYPE_OBJECT_Format, SPA_PARAM_EnumFormat,
            SPA_FORMAT_mediaType, SPA_POD_Id(SPA_MEDIA_TYPE_video),
            SPA_FORMAT_mediaSubtype, SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
            SPA_FORMAT_VIDEO_format, SPA_POD_Id(SPA_VIDEO_FORMAT_BGRx))
        : video_format(&builder, 0);
    c->update_params(c->stream, &format, 1);
}
/* Whether a buffer is held (a removed one never is). */
int ace_pw_holding(struct capture *c) { return c && c->held != NULL; }
