"""Blender sidebar for the parameterised Galaxy Watch4 ring mount."""
bl_info = {
    'name': 'Watch Ring Designer', 'author': 'Cam / Codex', 'version': (1, 0, 0),
    'blender': (5, 2, 0), 'location': '3D View > Sidebar > Ring Size',
    'description': 'Resize the finger cuff without moving the watch attachment features',
    'category': 'Add Mesh',
}
import bpy, bmesh, json
from pathlib import Path
from bpy.props import FloatProperty, PointerProperty, StringProperty
from bpy_extras.io_utils import ExportHelper
from . import geometry


def reference(context):
    return next((o for o in context.scene.objects if o.get('watch_ring_role')=='reference'),
                context.scene.objects.get('GalaxyWatch4_40mm_Body'))


def current_mount(context):
    return next((o for o in context.scene.objects if o.get('watch_ring_role')=='mount'),
                context.scene.objects.get('Concept_Open20mmCuff_TwoRotationTabs'))


def is_current(context):
    obj=current_mount(context)
    built=obj.get('watch_ring_built_diameter_mm',obj.get('finger_inner_diameter_mm',0)) if obj else 0
    return bool(obj and abs(built-context.scene.watch_ring_settings.diameter_mm)<1e-5)


def rebuild(context):
    old=current_mount(context)
    # Refuse transformed mounts rather than silently replacing them in a new place.
    if old and any(abs(old.matrix_world[i][j]-(1 if i==j else 0))>1e-6
                   for i in range(4) for j in range(4)):
        raise ValueError('Keep the mount at its original transform before resizing')
    new,report=geometry.build_mount(reference(context),context.scene.watch_ring_settings.diameter_mm)
    if old:
        old_mesh=old.data
        for collection in list(new.users_collection): collection.objects.unlink(new)
        for collection in old.users_collection: collection.objects.link(new)
        name=old.name
        bpy.data.objects.remove(old,do_unlink=True)
        if old_mesh.users==0:bpy.data.meshes.remove(old_mesh)
        new.name=name
    bpy.ops.object.select_all(action='DESELECT')
    new.select_set(True);context.view_layer.objects.active=new
    return new,report


def export_obj(context, filepath):
    if not is_current(context):
        raise ValueError('Click Apply Diameter before exporting the changed size')
    obj=current_mount(context)
    bm=bmesh.new()
    evaluated=obj.evaluated_get(context.evaluated_depsgraph_get())
    evaluated_mesh=evaluated.to_mesh()
    try:
        bm.from_mesh(evaluated_mesh)
        if not bm.faces or any(not e.is_manifold for e in bm.edges):
            raise ValueError('Mount is not a closed mesh; rebuild it before export')
    finally:
        bm.free();evaluated.to_mesh_clear()
    selected=list(context.selected_objects);active=context.view_layer.objects.active
    hidden=obj.hide_get()
    try:
        obj.hide_set(False)
        bpy.ops.object.select_all(action='DESELECT');obj.select_set(True)
        context.view_layer.objects.active=obj
        bpy.ops.wm.obj_export(filepath=filepath,export_selected_objects=True,
            export_materials=True,apply_modifiers=True,export_triangulated_mesh=True,
            forward_axis='Y',up_axis='Z',global_scale=1.0)
    finally:
        bpy.ops.object.select_all(action='DESELECT');obj.hide_set(hidden)
        for item in selected:item.select_set(True)
        context.view_layer.objects.active=active


class WATCHRING_Settings(bpy.types.PropertyGroup):
    diameter_mm: FloatProperty(name='Inner diameter (mm)', default=geometry.DEFAULT_DIAMETER,
        min=geometry.MIN_DIAMETER,max=geometry.MAX_DIAMETER,precision=2,step=10,
        description='Finger opening in millimetres, not outer diameter. Click Apply Diameter after editing')


class WATCHRING_OT_Rebuild(bpy.types.Operator):
    bl_idname='watch_ring.rebuild'
    bl_label='Apply Diameter'
    bl_description='Rebuild and validate only the mount; preserve the current one if validation fails'
    bl_options={'REGISTER','UNDO'}
    @classmethod
    def poll(cls,context):
        return context.mode=='OBJECT' and reference(context) is not None
    def execute(self,context):
        try:
            _,report=rebuild(context)
            self.report({'INFO'},f"Ring resized to {report['finger_diameter_mm']:g} mm; mesh checks passed")
            return {'FINISHED'}
        except Exception as exc:
            self.report({'ERROR'},str(exc));return {'CANCELLED'}


class WATCHRING_OT_Export(bpy.types.Operator,ExportHelper):
    bl_idname='watch_ring.export_obj'
    bl_label='Export Ring-only OBJ'
    filename_ext='.obj'
    filter_glob: StringProperty(default='*.obj',options={'HIDDEN'})
    @classmethod
    def poll(cls,context):
        return context.mode=='OBJECT' and is_current(context)
    def invoke(self,context,event):
        size=context.scene.watch_ring_settings.diameter_mm
        self.filepath=str(Path.home()/'Desktop'/f'watch-ring-{size:g}mm.obj')
        return ExportHelper.invoke(self,context,event)
    def execute(self,context):
        try:
            export_obj(context,self.filepath)
            self.report({'INFO'},'Exported ring only, in millimetres, with triangles')
            return {'FINISHED'}
        except Exception as exc:
            self.report({'ERROR'},str(exc));return {'CANCELLED'}


class WATCHRING_PT_Size(bpy.types.Panel):
    bl_label='Watch Ring Designer'
    bl_idname='WATCHRING_PT_Size'
    bl_space_type='VIEW_3D'
    bl_region_type='UI'
    bl_category='Ring Size'
    def draw(self,context):
        layout=self.layout
        if reference(context) is None:
            layout.label(text='Open Watch Ring Designer.blend',icon='INFO');return
        layout.prop(context.scene.watch_ring_settings,'diameter_mm')
        layout.operator('watch_ring.rebuild',icon='FILE_REFRESH')
        mount=current_mount(context)
        if mount:
            layout.label(text=f"Built: {mount.get('finger_inner_diameter_mm',0):g} mm")
        if not is_current(context):
            layout.label(text='Size changed: apply before export',icon='ERROR')
        layout.operator('watch_ring.export_obj',icon='EXPORT')
        box=layout.box()
        box.label(text='Fixed: watch fit, tabs and barrel axes')
        box.label(text='Ring wall: 1.8 mm | Barrel: 3.4 mm')
        box.label(text='Sizing range: 18–23 mm')
        layout.label(text='Save the .blend to keep your chosen size.')
        layout.label(text='Physical print-fit testing still required.',icon='INFO')


CLASSES=(WATCHRING_Settings,WATCHRING_OT_Rebuild,WATCHRING_OT_Export,WATCHRING_PT_Size)
def register():
    for cls in CLASSES:bpy.utils.register_class(cls)
    bpy.types.Scene.watch_ring_settings=PointerProperty(type=WATCHRING_Settings)

def unregister():
    if hasattr(bpy.types.Scene,'watch_ring_settings'):del bpy.types.Scene.watch_ring_settings
    for cls in reversed(CLASSES):bpy.utils.unregister_class(cls)

if __name__=='__main__':register()
