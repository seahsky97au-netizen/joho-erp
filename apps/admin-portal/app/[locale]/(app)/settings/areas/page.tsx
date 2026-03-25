'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Button,
  Badge,
  Input,
  Label,
  EmptyState,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  useToast,
} from '@joho-erp/ui';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@joho-erp/ui';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@joho-erp/ui';
import { Plus, Pencil, Trash2, Map, GripVertical } from 'lucide-react';
import { api } from '@/trpc/client';
import { SettingsPageHeader } from '@/components/settings/settings-page-header';

const COLOR_VARIANTS = [
  { value: 'info', label: 'Blue', className: 'bg-blue-100 text-blue-800' },
  { value: 'success', label: 'Green', className: 'bg-green-100 text-green-800' },
  { value: 'warning', label: 'Yellow', className: 'bg-yellow-100 text-yellow-800' },
  { value: 'gray', label: 'Gray', className: 'bg-gray-100 text-gray-800' },
  { value: 'secondary', label: 'Purple', className: 'bg-purple-100 text-purple-800' },
];

interface AreaFormData {
  name: string;
  displayName: string;
  colorVariant: string;
}

const initialFormData: AreaFormData = {
  name: '',
  displayName: '',
  colorVariant: 'gray',
};

// Type for area from API
type AreaWithCounts = {
  id: string;
  name: string;
  displayName: string;
  colorVariant: string;
  isActive: boolean;
  sortOrder: number;
  _count: {
    suburbMappings: number;
    driverAssignments: number;
  };
};

// Sortable row component
function SortableAreaRow({
  area,
  onEdit,
  onDelete,
  tColors,
}: {
  area: AreaWithCounts;
  onEdit: (area: AreaWithCounts) => void;
  onDelete: (area: AreaWithCounts) => void;
  tColors: (key: string) => string;
}) {
  const tCommon = useTranslations('common');
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: area.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <TableRow ref={setNodeRef} style={style} className={isDragging ? 'bg-muted' : ''}>
      <TableCell className="w-10">
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab touch-none p-1 hover:bg-muted rounded"
          aria-label={tCommon('aria.dragToReorder')}
        >
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </button>
      </TableCell>
      <TableCell className="font-mono text-sm">{area.name}</TableCell>
      <TableCell>
        <Badge variant={area.colorVariant as 'info' | 'success' | 'warning' | 'default' | 'secondary'}>
          {area.displayName}
        </Badge>
      </TableCell>
      <TableCell>
        <span className="text-sm text-muted-foreground">
          {tColors(area.colorVariant)}
        </span>
      </TableCell>
      <TableCell className="text-center">
        {area._count.suburbMappings}
      </TableCell>
      <TableCell className="text-center">
        {area._count.driverAssignments}
      </TableCell>
      <TableCell className="text-center">
        <Badge variant={area.isActive ? 'success' : 'secondary'}>
          {area.isActive ? 'Active' : 'Inactive'}
        </Badge>
      </TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onEdit(area)}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onDelete(area)}
            disabled={area._count.suburbMappings > 0 || area._count.driverAssignments > 0}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

export default function AreasPage() {
  const t = useTranslations('areas');
  const tCommon = useTranslations('common');
  const tColors = useTranslations('areas.colors');
  const { toast } = useToast();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [selectedArea, setSelectedArea] = useState<{ id: string; name: string } | null>(null);
  const [formData, setFormData] = useState<AreaFormData>(initialFormData);
  const [formErrors, setFormErrors] = useState<Partial<AreaFormData>>({});

  const utils = api.useUtils();

  const { data: areasData, isLoading } = api.area.listWithCounts.useQuery();
  const areas = (areasData || []) as AreaWithCounts[];

  // DnD sensors
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const createMutation = api.area.create.useMutation({
    onSuccess: () => {
      toast({ title: t('success.created') });
      setIsCreateDialogOpen(false);
      setFormData(initialFormData);
      utils.area.listWithCounts.invalidate();
    },
    onError: (error: { message: string }) => {
      if (error.message.includes('already exists')) {
        setFormErrors({ name: t('errors.nameExists') });
      } else {
        toast({ title: t('errors.createFailed'), variant: 'destructive' });
      }
    },
  });

  const updateMutation = api.area.update.useMutation({
    onSuccess: () => {
      toast({ title: t('success.updated') });
      setIsEditDialogOpen(false);
      setSelectedArea(null);
      setFormData(initialFormData);
      utils.area.listWithCounts.invalidate();
    },
    onError: () => {
      toast({ title: t('errors.updateFailed'), variant: 'destructive' });
    },
  });

  const deleteMutation = api.area.delete.useMutation({
    onSuccess: () => {
      toast({ title: t('success.deleted') });
      setIsDeleteDialogOpen(false);
      setSelectedArea(null);
      utils.area.listWithCounts.invalidate();
    },
    onError: (error: { message: string }) => {
      if (error.message.includes('Cannot delete')) {
        toast({ title: t('deleteConfirm.cannotDelete'), variant: 'destructive' });
      } else {
        toast({ title: t('errors.deleteFailed'), variant: 'destructive' });
      }
      setIsDeleteDialogOpen(false);
    },
  });

  const reorderMutation = api.area.reorder.useMutation({
    onSuccess: () => {
      toast({ title: t('success.reordered') });
      utils.area.listWithCounts.invalidate();
    },
    onError: () => {
      toast({ title: t('errors.reorderFailed'), variant: 'destructive' });
      // Refetch to restore original order
      utils.area.listWithCounts.invalidate();
    },
  });

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id && areas) {
      const oldIndex = areas.findIndex((area) => area.id === active.id);
      const newIndex = areas.findIndex((area) => area.id === over.id);

      // Optimistically update the UI
      const newOrder = arrayMove(areas, oldIndex, newIndex);

      // Send reorder request to API
      reorderMutation.mutate({
        areaIds: newOrder.map((area) => area.id),
      });
    }
  };

  const validateForm = (): boolean => {
    const errors: Partial<AreaFormData> = {};

    if (!formData.name) {
      errors.name = 'Required';
    } else if (!/^[a-z0-9-]+$/.test(formData.name)) {
      errors.name = t('fields.nameHelp');
    }

    if (!formData.displayName) {
      errors.displayName = 'Required';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleCreate = () => {
    if (!validateForm()) return;

    createMutation.mutate({
      name: formData.name,
      displayName: formData.displayName,
      colorVariant: formData.colorVariant as 'info' | 'success' | 'warning' | 'default' | 'secondary',
    });
  };

  const handleEdit = (area: AreaWithCounts) => {
    setSelectedArea({ id: area.id, name: area.name });
    setFormData({
      name: area.name,
      displayName: area.displayName,
      colorVariant: area.colorVariant,
    });
    setFormErrors({});
    setIsEditDialogOpen(true);
  };

  const handleUpdate = () => {
    if (!selectedArea) return;
    if (!formData.displayName) {
      setFormErrors({ displayName: 'Required' });
      return;
    }

    updateMutation.mutate({
      id: selectedArea.id,
      displayName: formData.displayName,
      colorVariant: formData.colorVariant as 'info' | 'success' | 'warning' | 'default' | 'secondary',
    });
  };

  const handleDelete = (area: AreaWithCounts) => {
    setSelectedArea({ id: area.id, name: area.displayName });
    setIsDeleteDialogOpen(true);
  };

  const confirmDelete = () => {
    if (!selectedArea) return;
    deleteMutation.mutate({ id: selectedArea.id });
  };

  const openCreateDialog = () => {
    setFormData(initialFormData);
    setFormErrors({});
    setIsCreateDialogOpen(true);
  };

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-6 md:py-10">
        <div className="animate-pulse">
          <div className="h-8 w-48 bg-muted rounded mb-4" />
          <div className="h-4 w-96 bg-muted rounded mb-8" />
          <div className="h-64 bg-muted rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 md:py-10">
      <SettingsPageHeader
        icon={Map}
        titleKey="title"
        descriptionKey="subtitle"
        namespace="areas"
      >
        <Button onClick={openCreateDialog}>
          <Plus className="h-4 w-4 mr-2" />
          {t('createArea')}
        </Button>
      </SettingsPageHeader>

      {/* Areas Table */}
      <Card>
        <CardHeader>
          <CardTitle>{t('title')}</CardTitle>
          <CardDescription>
            {areas?.length ?? 0} {areas?.length === 1 ? 'area' : 'areas'} configured
            {areas && areas.length > 1 && (
              <span className="ml-2 text-xs">
                ({t('dragToReorder')})
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!areas || areas.length === 0 ? (
            <EmptyState
              icon={Map}
              title={t('noAreas')}
              description={t('noAreasDescription')}
              action={{
                label: t('createArea'),
                onClick: openCreateDialog,
              }}
            />
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10"></TableHead>
                    <TableHead>{t('table.area')}</TableHead>
                    <TableHead>{t('table.displayName')}</TableHead>
                    <TableHead>{t('table.color')}</TableHead>
                    <TableHead className="text-center">{t('table.suburbs')}</TableHead>
                    <TableHead className="text-center">{t('table.drivers')}</TableHead>
                    <TableHead className="text-center">{t('table.status')}</TableHead>
                    <TableHead className="text-right">{t('table.actions')}</TableHead>
                  </TableRow>
                </TableHeader>
                <SortableContext
                  items={areas.map((a) => a.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <TableBody>
                    {areas.map((area) => (
                      <SortableAreaRow
                        key={area.id}
                        area={area}
                        onEdit={handleEdit}
                        onDelete={handleDelete}
                        tColors={tColors}
                      />
                    ))}
                  </TableBody>
                </SortableContext>
              </Table>
            </DndContext>
          )}
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('createArea')}</DialogTitle>
            <DialogDescription>
              {t('subtitle')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">{t('fields.name')}</Label>
              <Input
                id="name"
                placeholder={t('fields.namePlaceholder')}
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value.toLowerCase() })}
              />
              {formErrors.name && (
                <p className="text-sm text-destructive">{formErrors.name}</p>
              )}
              <p className="text-xs text-muted-foreground">{t('fields.nameHelp')}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="displayName">{t('fields.displayName')}</Label>
              <Input
                id="displayName"
                placeholder={t('fields.displayNamePlaceholder')}
                value={formData.displayName}
                onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
              />
              {formErrors.displayName && (
                <p className="text-sm text-destructive">{formErrors.displayName}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('fields.colorVariant')}</Label>
              <Select
                value={formData.colorVariant}
                onValueChange={(value) => setFormData({ ...formData, colorVariant: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COLOR_VARIANTS.map((color) => (
                    <SelectItem key={color.value} value={color.value}>
                      <div className="flex items-center gap-2">
                        <Badge variant={color.value as 'info' | 'success' | 'warning' | 'default' | 'secondary'}>
                          {tColors(color.value)}
                        </Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="pt-2">
              <Label>Preview</Label>
              <div className="mt-2">
                <Badge variant={formData.colorVariant as 'info' | 'success' | 'warning' | 'default' | 'secondary'}>
                  {formData.displayName || 'Area Name'}
                </Badge>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsCreateDialogOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? tCommon('saving') : tCommon('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('editArea')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>{t('fields.name')}</Label>
              <Input value={formData.name} disabled className="bg-muted" />
              <p className="text-xs text-muted-foreground">Area ID cannot be changed</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-displayName">{t('fields.displayName')}</Label>
              <Input
                id="edit-displayName"
                placeholder={t('fields.displayNamePlaceholder')}
                value={formData.displayName}
                onChange={(e) => setFormData({ ...formData, displayName: e.target.value })}
              />
              {formErrors.displayName && (
                <p className="text-sm text-destructive">{formErrors.displayName}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('fields.colorVariant')}</Label>
              <Select
                value={formData.colorVariant}
                onValueChange={(value) => setFormData({ ...formData, colorVariant: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COLOR_VARIANTS.map((color) => (
                    <SelectItem key={color.value} value={color.value}>
                      <div className="flex items-center gap-2">
                        <Badge variant={color.value as 'info' | 'success' | 'warning' | 'default' | 'secondary'}>
                          {tColors(color.value)}
                        </Badge>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="pt-2">
              <Label>Preview</Label>
              <div className="mt-2">
                <Badge variant={formData.colorVariant as 'info' | 'success' | 'warning' | 'default' | 'secondary'}>
                  {formData.displayName || 'Area Name'}
                </Badge>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              {tCommon('cancel')}
            </Button>
            <Button onClick={handleUpdate} disabled={updateMutation.isPending}>
              {updateMutation.isPending ? tCommon('saving') : tCommon('saveChanges')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteConfirm.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteConfirm.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteMutation.isPending ? 'Deleting...' : t('deleteConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
