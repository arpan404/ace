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
    void (*frame)(void *, const unsigned char *, unsigned, unsigned, int, unsigned);
    void *user;
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
static void format_changed(void *user, unsigned id, const struct spa_pod *pod) {
    struct capture *c = user;
    if (id != SPA_PARAM_Format || !pod) return;
    if (spa_format_video_raw_parse(pod, &c->video) < 0 ||
        c->video.size.width > 8192 || c->video.size.height > 8192 ||
        (uint64_t)c->video.size.width*c->video.size.height > 16777216) { c->failed = 1; return; }
    /* Ask for crop metadata: window streams mark the window's region inside a larger buffer. */
    unsigned char buffer[256];
    struct spa_pod_builder builder = SPA_POD_BUILDER_INIT(buffer, sizeof(buffer));
    const struct spa_pod *meta = spa_pod_builder_add_object(&builder, SPA_TYPE_OBJECT_ParamMeta, SPA_PARAM_Meta,
        SPA_PARAM_META_type, SPA_POD_Id(SPA_META_VideoCrop),
        SPA_PARAM_META_size, SPA_POD_Int(sizeof(struct spa_meta_region)));
    if (c->update_params) c->update_params(c->stream, &meta, 1);
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
static void process(void *user) {
    struct capture *c = user;
    struct pw_buffer *b = c->dequeue(c->stream);
    if (!b) return;
    if (!c->failed && b->buffer && b->buffer->n_datas > 0) {
        struct spa_meta_region *crop = spa_buffer_find_meta_data(b->buffer, SPA_META_VideoCrop, sizeof(*crop));
        c->has_crop = crop && spa_meta_region_is_valid(crop);
        if (c->has_crop) {
            c->crop_x = crop->region.position.x; c->crop_y = crop->region.position.y;
            c->crop_w = crop->region.size.width; c->crop_h = crop->region.size.height;
        }
        struct spa_data *d = &b->buffer->datas[0];
        unsigned w = c->video.size.width, h = c->video.size.height;
        size_t mapped = 0;
        unsigned char *base = readable(d, &mapped);
        if (base && d->chunk && w && h && d->chunk->stride >= (int)(w*4) &&
            d->chunk->offset <= d->maxsize && (uint64_t)d->chunk->stride*h <= d->maxsize-d->chunk->offset &&
            d->chunk->size >= (uint64_t)d->chunk->stride*(h-1)+w*4 && !(d->chunk->flags & SPA_CHUNK_FLAG_CORRUPTED)) {
            c->frame(c->user, base+d->chunk->offset,w,h,d->chunk->stride,c->video.format);
        }
        if (mapped) munmap(base - d->mapoffset, mapped);
    }
    c->queue(c->stream,b);
}
static const struct pw_stream_events events = {
    .version = PW_VERSION_STREAM_EVENTS, .state_changed = state_changed,
    .param_changed = format_changed, .process = process
};
#define LOAD(member, name) do { *(void **)(&member) = dlsym(c->library,name); if (!member) goto fail; } while (0)
void ace_pw_destroy(struct capture *c) {
    if (!c) return;
    if (c->stream && c->stream_destroy) c->stream_destroy(c->stream);
    if (c->core && c->disconnect) c->disconnect(c->core);
    if (c->context && c->context_destroy) c->context_destroy(c->context);
    if (c->wakeup && c->loop) pw_loop_destroy_source(c->get_loop(c->loop),c->wakeup);
    if (c->loop && c->loop_destroy) c->loop_destroy(c->loop);
    if (c->library) dlclose(c->library);
    free(c);
}
struct capture *ace_pw_open(int fd, unsigned node, int stop_fd, void (*frame)(void *, const unsigned char *, unsigned, unsigned, int, unsigned), void *user) {
    struct capture *c = calloc(1,sizeof(*c));
    int remote = fd;
    if (!c) { close(fd); return NULL; }
    c->frame=frame; c->user=user;
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
    const struct spa_pod *format=spa_pod_builder_add_object(&builder,SPA_TYPE_OBJECT_Format,SPA_PARAM_EnumFormat,
        SPA_FORMAT_mediaType,SPA_POD_Id(SPA_MEDIA_TYPE_video),
        SPA_FORMAT_mediaSubtype,SPA_POD_Id(SPA_MEDIA_SUBTYPE_raw),
        SPA_FORMAT_VIDEO_format,SPA_POD_CHOICE_ENUM_Id(4,SPA_VIDEO_FORMAT_BGRx,SPA_VIDEO_FORMAT_BGRA,SPA_VIDEO_FORMAT_RGBx,SPA_VIDEO_FORMAT_RGBA));
    if (connect(c->stream,PW_DIRECTION_INPUT,node,PW_STREAM_FLAG_AUTOCONNECT|PW_STREAM_FLAG_MAP_BUFFERS,&format,1)<0) goto fail;
    return c;
fail:
    if (remote>=0) close(remote);
    ace_pw_destroy(c); return NULL;
}
/* The valid region of the frame being delivered; 0 when the producer sent none. */
int ace_pw_crop(struct capture *c, int *x, int *y, unsigned *w, unsigned *h) {
    if (!c || !c->has_crop) return 0;
    *x = c->crop_x; *y = c->crop_y; *w = c->crop_w; *h = c->crop_h;
    return 1;
}
int ace_pw_step(struct capture *c, int timeout) {
    if (c->failed) return -1;
    return pw_loop_iterate(c->get_loop(c->loop),timeout);
}
