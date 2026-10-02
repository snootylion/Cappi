"""Parametric version of the proven v12 mount. Units: millimetres.
Only the cuff radius/centre and connecting shoulder curves depend on diameter.
Tab geometry, barrel axes, access notches and the case reference stay fixed.
"""
import bpy, bmesh, math, json
from mathutils import Vector

DEFAULT_DIAMETER = 21.3
MIN_DIAMETER = 18.0
MAX_DIAMETER = 23.0

def checked_diameter(value):
    value=float(value)
    if not math.isfinite(value) or not MIN_DIAMETER <= value <= MAX_DIAMETER:
        raise ValueError(f"Diameter must be between {MIN_DIAMETER:g} and {MAX_DIAMETER:g} mm")
    return round(value,2)

def build_mount(body, diameter_mm=DEFAULT_DIAMETER):
    """Build and validate a new object; leave any previous mount untouched.
    On failure, remove only data created by this operation.
    """
    diameter_mm=checked_diameter(diameter_mm)
    if body is None or body.type != 'MESH':
        raise ValueError('A watch reference mesh is required')
    if bpy.context.mode != 'OBJECT':
        raise ValueError('Switch to Object Mode before resizing')
    if any(abs(body.matrix_world[i][j]-(1 if i==j else 0))>1e-6
           for i in range(4) for j in range(4)):
        raise ValueError('The watch reference must keep its original transform')
    before={kind:set(getattr(bpy.data,kind)) for kind in ('objects','meshes','materials')}
    selected=list(bpy.context.selected_objects)
    active=bpy.context.view_layer.objects.active
    try:
        result=_build_mount(body, diameter_mm)
        for kind in ('meshes','materials'):
            block=getattr(bpy.data,kind)
            for item in set(block)-before[kind]:
                if item.users==0:block.remove(item)
        return result
    except Exception:
        for obj in set(bpy.data.objects)-before['objects']:
            bpy.data.objects.remove(obj,do_unlink=True)
        for kind in ('meshes','materials'):
            block=getattr(bpy.data,kind)
            for item in set(block)-before[kind]:
                if item.users==0: block.remove(item)
        bpy.ops.object.select_all(action='DESELECT')
        for obj in selected:
            if obj.name in bpy.context.view_layer.objects: obj.select_set(True)
        if active and active.name in bpy.context.view_layer.objects:
            bpy.context.view_layer.objects.active=active
        raise

def _build_mount(body, diameter_mm):
    R, WALL, WIDTH = diameter_mm/2, 1.8, 20.0
    TAB_ROOT_WIDTH = 20.0
    TAB_THICKNESS, CUFF_ARC = 2.6, 300.0
    CZ = min(v.co.z for v in body.data.vertices) - R
    MID = R + WALL / 2
    # A single continuous ribbon: thin rounded paddles, a sweeping fan into the
    # outside of the cuff, and an unchanged circular finger surface. No stacked
    # lug fillers or thickened block supports.
    LUG_END_Y, TAB_TIP_Y = 23.475, 29.4875
    TAB_THICKNESS = 1.6

    def bezier(p0,p1,p2,p3,t):
        u=1-t
        return tuple(u**3*p0[j]+3*u*u*t*p1[j]+3*u*t*t*p2[j]+t**3*p3[j] for j in (0,1))

    def smooth(t): return t*t*(3-2*t)

    # Raise only the body-facing top surface. The proven underside and cuff
    # remain unchanged; a broad smooth shoulder replaces a protruding barrel boss.
    TOP_RAISE = 2.5
    def top_raise(y):
        y=abs(y)
        if y<15.5 or y>29.4875: return 0.0
        if y<18: return TOP_RAISE*smooth((y-15.5)/2.5)
        if y<=20.3: return TOP_RAISE
        return TOP_RAISE*(1-smooth((y-20.3)/(29.4875-20.3)))

    # Each section is (inner/lower YZ, outer/upper YZ, width).
    wing=[]
    for i in range(65):
        u=(math.pi/2)*(1-i/64)
        y=22.3+(TAB_TIP_Y-22.3)*math.sin(u)
        w=max(.35,TAB_ROOT_WIDTH*math.cos(u))
        t=(y-22.3)/(TAB_TIP_Y-22.3)
        h=2.05+(TAB_THICKNESS/2-2.05)*smooth(t)
        z=-.45-.35*smooth(t)
        wing.append(((y,z-h),(y,z+h),w))
    # The lower edge meets the outer circle tangentially at 60 degrees. This
    # supplies a wide continuous support fan rather than a narrow attachment.
    outer_end=((R+WALL)*math.sin(math.radians(60)),CZ+(R+WALL)*.5)
    inner_end=(R*.5,CZ+R*math.cos(math.radians(30)))
    for i in range(1,81):
        t=i/80
        lower=bezier((22.3,-2.5),(16.5,-3.1),
                     (outer_end[0]-1.5,outer_end[1]+2.598),outer_end,t)
        upper=bezier((22.3,1.6),(16.0,1.6),(9.0,-4.2),inner_end,t)
        w=TAB_ROOT_WIDTH+(WIDTH-TAB_ROOT_WIDTH)*smooth(t)
        wing.append((lower,upper,w))

    stations=list(wing)
    for i in range(1,241):
        a=30+300*i/240
        # Smoothly spread the support over the cuff shoulder, then return to
        # constant wall thickness for the main ring.
        if a<90: ao=a+30*(1-(a-30)/60)**2
        elif a>270: ao=a-30*((a-270)/60)**2
        else: ao=a
        ai=math.radians(a); ao=math.radians(ao)
        inner=(R*math.sin(ai),CZ+R*math.cos(ai))
        outer=((R+WALL)*math.sin(ao),CZ+(R+WALL)*math.cos(ao))
        stations.append((outer,inner,WIDTH))
    stations += [((-lo[0],lo[1]),(-hi[0],hi[1]),w) for lo,hi,w in reversed(wing[:-1])]
    # Sweep the tab/support across the circular case rather than extruding a
    # flat cross-section. The centreline and rounded free tips remain in place.
    CASE_WRAP_RADIUS=19.65
    NX=17
    SECTION=2*NX

    def envelope(y,a,b,c,d):
        y=abs(y)
        if y<=a or y>=d:return 0.0
        if y<b:return smooth((y-a)/(b-a))
        if y<=c:return 1.0
        return 1-smooth((y-c)/(d-c))

    def wrapped_y(x,y):
        sag=CASE_WRAP_RADIUS-math.sqrt(CASE_WRAP_RADIUS**2-x*x)
        return math.copysign(abs(y)-sag*envelope(y,13.5,17,23.475,TAB_TIP_Y),y)

    verts,faces=[],[]
    for lower,upper,w in stations:
        upper=(upper[0],upper[1]+top_raise(upper[0]))
        lower=(lower[0],lower[1]-.6*envelope(lower[0],13.5,17,22.3,27.5))
        for point,indices in [(lower,range(NX)),(upper,reversed(range(NX)))]:
            for j in indices:
                x=-w/2+w*j/(NX-1)
                verts.append((x,wrapped_y(x,point[0]),point[1]))
    faces.append(tuple(reversed(range(SECTION))))
    for i in range(len(stations)-1):
        for j in range(SECTION):
            faces.append((SECTION*i+j,SECTION*i+(j+1)%SECTION,
                          SECTION*(i+1)+(j+1)%SECTION,SECTION*(i+1)+j))
    faces.append(tuple(SECTION*(len(stations)-1)+j for j in range(SECTION)))
    mesh=bpy.data.meshes.new('OpenCuff_and_LugTabs'); mesh.from_pydata(verts,[],faces); mesh.update()
    mount=bpy.data.objects.new('Concept_Open20mmCuff_TwoRotationTabs',mesh)
    bpy.context.collection.objects.link(mount)
    bm=bmesh.new(); bm.from_mesh(mesh); bmesh.ops.triangulate(bm,faces=list(bm.faces)); bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces)); bm.to_mesh(mesh); bm.free()
    bpy.context.view_layer.objects.active=mount
    bpy.ops.object.select_all(action='DESELECT'); mount.select_set(True)
    bevel=mount.modifiers.new('Soft concept edges','BEVEL'); bevel.width=.25; bevel.segments=6
    bpy.ops.object.modifier_apply(modifier=bevel.name)
    # Trim the continuous fan against the watch without adding separate filler
    # blocks. Keep the central finger-contact window exposed.
    def boolean(target, cutter, operation, remove=True):
        bpy.context.view_layer.objects.active=target
        mod=target.modifiers.new(operation,'BOOLEAN'); mod.operation=operation
        mod.solver='MANIFOLD'; mod.object=cutter
        bpy.ops.object.modifier_apply(modifier=mod.name)
        if remove: bpy.data.objects.remove(cutter,do_unlink=True)
        # Repair only coincident boundary vertices from curved Boolean seams;
        # never weld the detailed, already-closed bevel geometry globally.
        repair=bmesh.new();repair.from_mesh(target.data)
        boundary=list({v for e in repair.edges if e.is_boundary for v in e.verts})
        if boundary:
            bmesh.ops.remove_doubles(repair,verts=boundary,dist=.00001)
            wire=[e for e in repair.edges if e.is_wire]
            if wire:bmesh.ops.delete(repair,geom=wire,context='EDGES')
        repair.to_mesh(target.data);repair.free();target.data.update()

    boolean(mount,body,'DIFFERENCE',remove=False)
    # Fit revision: 1.8 mm inward and 0.6 mm up from the original hole centres.
    BAR_D, BORE_D, PIN_Y, PIN_Z = 1.5, 3.4, 20.5, .15
    # Keep the existing inner ends, extend each access notch beyond the side edge.
    LEVER_INNER, LEVER_OUTER, LEVER_WIDTH = 3.75, WIDTH/2+1.0, 2.4
    LEVER_X=(LEVER_INNER+LEVER_OUTER)/2
    LEVER_LENGTH=LEVER_OUTER-LEVER_INNER
    for sign in (-1,1):
        bpy.ops.mesh.primitive_cylinder_add(vertices=128,radius=BORE_D/2,depth=26,
            location=(0,sign*PIN_Y,PIN_Z),rotation=(0,math.pi/2,0))
        boolean(mount,bpy.context.object,'DIFFERENCE')
        # Rounded, side-open underside access notches. The cutter passes beyond
        # the tab sides while leaving the roof over each barrel intact.
        for side in (-1,1):
            bpy.ops.mesh.primitive_cube_add(size=1,location=(side*LEVER_X,sign*PIN_Y,-3.0))
            cutter=bpy.context.object; cutter.dimensions=(LEVER_LENGTH,LEVER_WIDTH,7.4)
            bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
            bev=cutter.modifiers.new('Rounded lever window','BEVEL');bev.width=.35;bev.segments=6
            bpy.ops.object.modifier_apply(modifier=bev.name)
            boolean(mount,cutter,'DIFFERENCE')
    # Round only the sharp channel/case intersection lips. This is a local
    # subtractive edge treatment, not a change to barrel axes or bore diameter.
    from mathutils.bvhtree import BVHTree
    case_tree=BVHTree.FromObject(body,bpy.context.evaluated_depsgraph_get())
    bm=bmesh.new();bm.from_mesh(mount.data);bm.normal_update()
    def on_case(v):
        nearest=case_tree.find_nearest(v.co)
        return nearest[0] is not None and nearest[3]<.025
    lip_edges=[]
    for edge in bm.edges:
        if not edge.is_manifold: continue
        mid=(edge.verts[0].co+edge.verts[1].co)*.5
        if abs(abs(mid.y)-PIN_Y)>BORE_D/2+.15 or abs(mid.z-PIN_Z)>BORE_D/2+.15: continue
        if edge.calc_face_angle()<math.radians(18): continue
        if all(on_case(v) for v in edge.verts): lip_edges.append(edge)
    LIP_RADIUS=.10
    lip_edge_count=len(lip_edges)
    assert lip_edge_count>0,'No channel/case lip edges found'
    bmesh.ops.bevel(bm,geom=lip_edges,offset=LIP_RADIUS,segments=5,
                     affect='EDGES',clamp_overlap=True,profile=.5)
    bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces))
    bm.to_mesh(mount.data);bm.free();mount.data.update()
    # Remove only sub-0.25 mm disconnected Boolean slivers from the edge trim.
    bm=bmesh.new();bm.from_mesh(mount.data);visited=set();slivers=[]
    for seed in bm.verts:
        if seed in visited: continue
        group=[];stack=[seed];visited.add(seed)
        while stack:
            v=stack.pop();group.append(v)
            for edge in v.link_edges:
                n=edge.other_vert(v)
                if n not in visited: visited.add(n);stack.append(n)
        extent=max(max(v.co[j] for v in group)-min(v.co[j] for v in group) for j in range(3))
        if len(group)<10 and extent<.25: slivers.extend(group)
    if slivers: bmesh.ops.delete(bm,geom=slivers,context='VERTS')
    bm.to_mesh(mount.data);bm.free();mount.data.update()
    mount['channel_mouth_edge_radius_mm']=LIP_RADIUS
    mount['spring_bar_barrel_mm']=BAR_D; mount['spring_bar_channel_mm']=BORE_D
    mount['retention_note']='Pin axes and release access require physical fit verification.'
    mat=bpy.data.materials.new('Concept matte PLA'); mat.diffuse_color=(.42,.19,.065,1); mat.use_nodes=True
    bs=mat.node_tree.nodes.get('Principled BSDF'); bs.inputs['Base Color'].default_value=mat.diffuse_color
    bs.inputs['Metallic'].default_value=0; bs.inputs['Roughness'].default_value=.55
    mount.data.materials.clear(); mount.data.materials.append(mat)
    for poly in mount.data.polygons: poly.material_index=0
    mount['concept_only']=True; mount['finger_inner_diameter_mm']=2*R; mount['lug_gap_width_mm']=TAB_ROOT_WIDTH; mount['triangular_transition']='continuous thin-tip fan with tangential cuff shoulders'
    mount['wall_mm']=WALL; mount['axial_width_mm']=WIDTH
    mount['open_top_degrees']=360-CUFF_ARC; mount['cuff_arc_degrees']=CUFF_ARC; mount['tab_thickness_mm']=TAB_THICKNESS; mount['finger_axis']='X; perpendicular to lug/tab Y axis'
    mount['rotation']='Whole assembly rotates around finger using either end paddle; no mechanical bearing.'

    # Verification of the actual delivered mesh and the open contact region.
    bm=bmesh.new(); bm.from_mesh(mount.data)
    nonmanifold=sum(not e.is_manifold for e in bm.edges)
    seen=set(); components=0
    for v in bm.verts:
        if v in seen: continue
        components+=1; seen.add(v); stack=[v]
        while stack:
            v=stack.pop()
            for e in v.link_edges:
                n=e.other_vert(v)
                if n not in seen: seen.add(n); stack.append(n)
    bm.free()
    up_hit=mount.ray_cast(Vector((0,0,CZ)),Vector((0,0,1)))[0]
    down_hit,down_loc,_,_=mount.ray_cast(Vector((0,0,CZ)),Vector((0,0,-1)))
    bar_channels_open = all(not mount.ray_cast(Vector((-14,sy*PIN_Y,PIN_Z)),Vector((1,0,0)))[0] for sy in (-1,1))
    release_access_open=all(not mount.ray_cast(Vector((sx*LEVER_X,sy*PIN_Y,PIN_Z-.2)),Vector((0,0,-1)))[0]
                            for sx in (-1,1) for sy in (-1,1))
    side_access_open=all(not mount.ray_cast(
        Vector((sx*(LEVER_INNER+.6),sy*PIN_Y,PIN_Z-BORE_D/2-.4)),Vector((sx,0,0)))[0]
        for sx in (-1,1) for sy in (-1,1))
    inner_clearance=[]
    for i in range(301):
        a=math.radians(30+i)
        direction=Vector((0,math.sin(a),math.cos(a)))
        hit,point,_,_=mount.ray_cast(Vector((0,0,CZ)),direction)
        inner_clearance.append((point-Vector((0,0,CZ))).length if hit else float('inf'))
    bore_radii=[]
    for sy in (-1,1):
        hit,point,_,_=mount.ray_cast(Vector((TAB_ROOT_WIDTH/2-.7,sy*PIN_Y,PIN_Z)),Vector((0,0,1)))
        bore_radii.append(point.z-PIN_Z if hit else -1)
    report={'spring_bar_barrel_mm':BAR_D,'spring_bar_channel_mm':BORE_D,'measured_channel_diameters_mm':[round(2*r,4) for r in bore_radii],'concept_only':True,'finger_axis':'X','finger_diameter_mm':2*R,'wall_mm':WALL,
            'cuff_width_mm':WIDTH,'tab_root_width_mm':TAB_ROOT_WIDTH,'open_top_degrees':360-CUFF_ARC,'cuff_arc_degrees':CUFF_ARC,'tab_thickness_mm':TAB_THICKNESS,'inner_tab_top_raise_mm':TOP_RAISE,'support_added_below_mm':.6,'case_wrap_radius_mm':CASE_WRAP_RADIUS,'bore_measurement_x_mm':TAB_ROOT_WIDTH/2-.7,'hole_centres_y_mm':[-PIN_Y,PIN_Y],'hole_centre_z_mm':PIN_Z,'lever_slot_length_mm':LEVER_LENGTH,'lever_slot_width_mm':LEVER_WIDTH,'lever_access_style':'side-open notches','finger_center_z':CZ,
            'finger_top_z':CZ+R,'watch_sensor_lowest_z':min(v.co.z for v in body.data.vertices),
            'underside_saddle':'Flush to watch, central skin-contact opening retained','contact_window_width_mm':R,'tabs_lug_axis':'Y','tab_tips_y_mm':[-TAB_TIP_Y,TAB_TIP_Y],'tab_extension_beyond_lugs_mm':TAB_TIP_Y-LUG_END_Y,
            'checks':{'both_bar_channels_open':bar_channels_open,'release_access_open':release_access_open,'access_notches_open_to_sides':side_access_open,'full_finger_arc_clear':min(inner_clearance)>=R-.02,'channel_diameter_3_4mm':all(abs(2*r-BORE_D)<.01 for r in bore_radii),'at_least_three_quarter_circle':CUFF_ARC>=270,'closed_mount_mesh':nonmanifold==0,'single_connected_mount':components==1,
                      'no_material_above_finger_center':not up_hit,
                      'inner_radius_matches_target':bool(down_hit and abs((CZ-down_loc.z)-R)<.08)}}
    # Keep the reference-case interference explicit: body clearance is preserved
    # by the case trim, but an enlarged bore can open into that mating surface.
    case_hit,case_point,_,_=body.ray_cast(Vector((0,30,PIN_Z)),Vector((0,-1,0)))
    report['reference_hole_overlap_mm']=round(max(0,case_point.y-(PIN_Y-BORE_D/2)),4) if case_hit else None
    report['channel_mouth_edge_radius_mm']=LIP_RADIUS
    report['channel_mouth_edges_rounded']=lip_edge_count
    report['reference_fit_note']='Positive overlap means the barrel channel opens into the reference watch-facing surface; verify physical fit.'
    assert all(report['checks'].values()),report

    mount['watch_ring_role']='mount'
    mount['watch_ring_built_diameter_mm']=diameter_mm
    mount['watch_ring_validation']=json.dumps(report)
    return mount, report
