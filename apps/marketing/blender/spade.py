# Spade in 3D, built from the mark's geometry (docs/design/spade/README.md) and exported as the
# GLB the home page shows (public/spade.glb). Every part of the face lies on the head's surface,
# with its origin at the head's centre, so turning a pupil about that centre slides it across
# the eye.
#
# The exported public/spade.glb is committed: the site's build only copies it, so building or
# deploying never needs Blender. Run this by hand only when Spade's shape changes, then commit
# the new GLB.
#
#   /Applications/Blender.app/Contents/MacOS/Blender --background \
#     --python apps/marketing/blender/spade.py -- apps/marketing/public/spade.glb [preview.png]
import math
import sys

import bmesh
import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
glb_path = args[0] if args else "spade.glb"
preview_path = args[1] if len(args) > 1 else None

# The mark's 24-unit grid, centred and scaled so the head's radius is 1.06.
UNIT = 0.1
RADIUS = 10.6 * UNIT
# The mark turns its face −4° in the SVG's y-down frame, which is +4° in this y-up one.
TILT = math.radians(4)
EYES = {"L": (8.7 - 12, 12 - 11.9), "R": (15.3 - 12, 12 - 11.9)}  # face plane, v up
EYE = (2.3, 3.55)
RING = 0.62
PUPIL = (1.1, 1.6)
PAD = 0.22
REST = (-0.25, -2.0)  # where the pupils rest, v up

# Monochrome: paper eyes with ink outlines and pupils. The page sets the head's colour per theme.
PAPER = (0.92, 0.92, 0.93, 1)
INK = (0.007, 0.007, 0.008, 1)
HEAD = (0.83, 0.82, 0.79, 1)


def material(name, colour, roughness):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = colour
    bsdf.inputs["Roughness"].default_value = roughness
    return mat


def on_head(u, v, lift):
    """A point of the face plane (grid units, tilted) on the head's front, `lift` above it."""
    c, s = math.cos(TILT), math.sin(TILT)
    x, z = (u * c - v * s) * UNIT, (u * s + v * c) * UNIT
    y = -math.sqrt(max(RADIUS * RADIUS - x * x - z * z, 1e-6))
    return Vector((x, y, z)).normalized() * (RADIUS + lift)


def egg(theta, rx, ry):
    """The eye's outline: an ellipse a little narrower and flatter over its top half."""
    s, c = math.sin(theta), math.cos(theta)
    top = max(s, 0.0)
    return rx * c * (1 - 0.1 * top), ry * s * (1 - 0.06 * top)


def shell(name, centre, radii, lift, bulge, mat, segments=72, rings=10):
    """An egg-shaped piece lying on the head, domed in its middle by `bulge`."""
    bm = bmesh.new()
    cu, cv = centre
    rx, ry = radii
    grid = []
    for k in range(rings + 1):
        t = k / rings
        count = segments if k else 1
        row = []
        for j in range(count):
            du, dv = egg(2 * math.pi * j / segments, rx, ry)
            row.append(bm.verts.new(on_head(cu + du * t, cv + dv * t, lift + bulge * (1 - t * t))))
        grid.append(row)
    for j in range(segments):
        bm.faces.new((grid[0][0], grid[1][j], grid[1][(j + 1) % segments]))
    for k in range(1, rings):
        a, b = grid[k], grid[k + 1]
        for j in range(segments):
            n = (j + 1) % segments
            bm.faces.new((a[j], b[j], b[n], a[n]))
    bm.normal_update()
    bm.faces.ensure_lookup_table()
    # Faces point away from the head's centre.
    face = bm.faces[0]
    if face.normal.dot(face.calc_center_median()) < 0:
        bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for poly in mesh.polygons:
        poly.use_smooth = True
    mesh.materials.append(mat)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    return obj


def pupil_rest(eye):
    """The pupil's resting centre, kept inside the eye the way the mark clamps it."""
    ax, ay = EYE[0] - PUPIL[0] - PAD, EYE[1] - PUPIL[1] - PAD
    dx, dy = REST
    k = math.hypot(dx / ax, dy / ay)
    if k > 1:
        dx, dy = dx / k, dy / k
    return eye[0] + dx, eye[1] + dy


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    head_mat = material("Head", HEAD, 0.38)
    paper = material("Paper", PAPER, 0.12)
    ink = material("Ink", INK, 0.25)

    bpy.ops.mesh.primitive_uv_sphere_add(segments=64, ring_count=32, radius=RADIUS)
    head = bpy.context.active_object
    head.name = "Head"
    bpy.ops.object.shade_smooth()
    head.data.materials.append(head_mat)

    for side, eye in EYES.items():
        shell(f"Ring_{side}", eye, (EYE[0] + RING, EYE[1] + RING), 0.004, 0.018, ink)
        shell(f"Eye_{side}", eye, EYE, 0.008, 0.045, paper)
        p = pupil_rest(eye)
        shell(f"Pupil_{side}", p, PUPIL, 0.052, 0.012, ink, segments=48, rings=6)
        glint = (p[0] + PUPIL[0] * 0.38, p[1] + PUPIL[1] * 0.42)
        r = PUPIL[0] * 0.3
        shell(f"Glint_{side}", glint, (r, r), 0.066, 0.004, paper, segments=32, rings=4)


def render_preview(path):
    """A still for checking the model by eye; the camera and lights stay out of the GLB."""
    scene = bpy.context.scene
    engines = [e.identifier for e in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
    scene.render.resolution_x = scene.render.resolution_y = 1200
    world = bpy.data.worlds.new("World")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.012, 0.012, 0.011, 1)
    added = []

    def aim(obj, loc):
        obj.location = loc
        obj.rotation_euler = (Vector((0, 0, 0)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        bpy.context.collection.objects.link(obj)
        added.append(obj)

    camera = bpy.data.cameras.new("Camera")
    camera.lens = 85
    cam = bpy.data.objects.new("Camera", camera)
    aim(cam, (1.6, -6.4, 0.9))
    scene.camera = cam
    for name, loc, energy, size in (
        ("Key", (-3, -4, 4), 900, 3),
        ("Fill", (4, -3, 0.5), 250, 4),
        ("Rim", (1, 4, 3), 600, 2),
    ):
        light = bpy.data.lights.new(name, "AREA")
        light.energy = energy
        light.size = size
        aim(bpy.data.objects.new(name, light), loc)

    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    for obj in added:
        bpy.data.objects.remove(obj)


build()
if preview_path:
    render_preview(preview_path)
bpy.ops.export_scene.gltf(filepath=glb_path, export_format="GLB", export_apply=True)
