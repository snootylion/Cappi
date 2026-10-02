WATCH RING DESIGNER

Default inner diameter: 21.3 mm. Tested sizing range: 18–23 mm.
Requires Blender 5.2 or later; tested with 5.2.1.

QUICK START (no installation)
1. Open Watch Ring Designer.blend.
2. Switch to the Scripting workspace. Select START_HERE.py in the text editor if needed.
3. Click Run Script (triangle), or press Alt+P with your pointer in the text editor.
4. Switch to Layout. Press N over the viewport and select the Ring Size tab.
5. Enter Inner diameter (mm), then click Apply Diameter.
6. Click Export Ring-only OBJ and choose your destination.

Run START_HERE.py again after restarting Blender if you have not installed the add-on.
The saved Blender file includes all required code and the watch reference.
Save the .blend after changing size to keep that version.

OPTIONAL ONE-TIME INSTALL
In Blender Preferences > Add-ons, choose Install from Disk from the menu.
Choose Watch Ring Designer Add-on.zip and enable Watch Ring Designer.
The Ring Size sidebar will then be available without running START_HERE.py.

WHAT CHANGES
The finger opening and its smooth support transition are regenerated, not globally scaled.
Tab width (20 mm), watch fit, barrel positions/diameter and lever access stay fixed.
Ring wall thickness stays 1.8 mm. Diameter is the inside opening, not outside size.
The 21.3 mm output matches the latest existing model.

EXPORT
Only the mount is exported, without the watch, and all faces are triangles.
OBJ has no unit metadata: import into your slicer as millimetres at 100% scale.
Keep the companion MTL file if you want its material; it is not needed for printing.
Mesh validation is automatic but physical fit and print strength still need testing.
Keep the reference and mount at their original position/rotation/scale.
